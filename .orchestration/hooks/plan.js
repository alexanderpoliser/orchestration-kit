'use strict';
// Plan = one .md per task in .orchestration/tasks/ (e.g. TASK-001.md), with frontmatter.
// The header holds what the hook enforces; the body holds the goal and acceptance criteria in prose.
// The same code serves the hook (enforces) and `cli.js validate` (warns the Planner before dispatch).
const fs = require('node:fs');
const path = require('node:path');
const { ORCH } = require('./lib');

const DIR = path.join(ORCH, 'tasks');
const ROOT = path.dirname(ORCH);
const KEYS = ['id', 'title', 'cycle', 'depends_on', 'allowed_paths', 'skills', 'branch'];
const BOM = 0xfeff;

const unquote = (s) => { const m = s.match(/^(["'])(.*)\1$/); return m ? m[2] : s; };
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isList = (v) => Array.isArray(v) && v.every(isText);

// Strict YAML subset: `key: value`, `key: [a, b]` and block lists (`key:` followed by `- item` lines).
// No end-of-line comments. Anything else is an error with a line number: better to fail loudly
// than to read it differently from a real YAML parser.
function parseFrontmatter(text) {
  const lines = (text.charCodeAt(0) === BOM ? text.slice(1) : text).split(/\r?\n/);
  if (lines[0].trim() !== '---') return { errors: [[1, 'file must start with frontmatter (---)']] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { errors: [[1, 'frontmatter is missing the closing ---']] };

  const data = {};
  const lineOf = {};
  const errors = [];
  let list = null; // key currently receiving `- x` items
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const n = i + 1;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item) {
      if (list) data[list].push(unquote(item[1].trim()));
      else errors.push([n, 'list item without an empty key above it (e.g. "allowed_paths:")']);
      continue;
    }
    list = null;
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (!kv) { errors.push([n, `unrecognized line: "${line.trim()}"`]); continue; }
    const key = kv[1];
    const v = (kv[2] || '').trim();
    if (key in data) errors.push([n, `duplicate key "${key}"`]);
    lineOf[key] = n;
    if (!v) { data[key] = []; list = key; }
    else if (v.startsWith('[')) {
      if (v.endsWith(']')) data[key] = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      else errors.push([n, `list in ${key} is missing "]"`]);
    } else data[key] = unquote(v);
  }
  return { data, lineOf, errors, body: lines.slice(end + 1).join('\n').trim() };
}

function checkTask(file, cfg) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const name = path.basename(file, '.md');
  const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const errors = fm.errors.map(([n, msg]) => `${rel}:${n}: ${msg}`);
  if (!fm.data) return { errors };
  const d = fm.data;
  const err = (key, msg) => errors.push(`${rel}:${fm.lineOf[key] || 1}: ${msg}`);

  for (const k of Object.keys(d)) if (!KEYS.includes(k)) err(k, `unknown key "${k}" (valid: ${KEYS.join(', ')})`);
  if (!isText(d.id)) err('id', 'id is required');
  else if (!new RegExp(`^(?:${cfg.taskIdPattern})$`).test(d.id)) err('id', `id "${d.id}" does not match the pattern ${cfg.taskIdPattern}`);
  else if (d.id !== name) err('id', `id "${d.id}" does not match the file name (${name}.md)`);
  if (!isText(d.title)) err('title', 'title is required');
  if (d.cycle !== undefined && !/^[1-9]\d*$/.test(d.cycle)) err('cycle', 'cycle must be an integer >= 1');
  if (d.depends_on !== undefined && !isList(d.depends_on)) err('depends_on', 'depends_on must be a list of ids');
  if (!isList(d.allowed_paths) || !d.allowed_paths.length) err('allowed_paths', 'allowed_paths must be a non-empty list of globs');
  if (d.skills !== undefined && !isList(d.skills)) err('skills', 'skills must be a list of paths');
  if (d.branch !== undefined && !isText(d.branch)) err('branch', 'branch must be text');
  if (!fm.body) errors.push(`${rel}: empty body; describe the goal and acceptance criteria below the frontmatter`);
  if (errors.length) return { errors };

  return {
    errors,
    task: {
      id: d.id,
      title: d.title,
      cycle: Number(d.cycle || 1),
      depends_on: d.depends_on || [],
      allowed_paths: d.allowed_paths,
      skills: d.skills || [],
      branch: d.branch || null,
      body: fm.body,
      file: rel,
    },
  };
}

// Cross-file checks: missing dependency, dependency on a later cycle (never dispatches) and loops.
function checkGraph(tasks, names) {
  const errors = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      const other = byId.get(dep);
      if (!names.has(dep)) errors.push(`${t.file}: depends_on references ${dep}, which does not exist in .orchestration/tasks/`);
      else if (other && other.cycle > t.cycle) {
        errors.push(`${t.file}: depends on ${dep} (cycle ${other.cycle}), which is later than this task's cycle ${t.cycle}; it would never dispatch`);
      }
    }
  }
  const mark = new Map(); // 1 = visiting, 2 = done
  const visit = (id, trail) => {
    mark.set(id, 1);
    for (const dep of byId.get(id).depends_on) {
      if (!byId.has(dep)) continue;
      if (mark.get(dep) === 1) {
        const loop = [...trail, id];
        errors.push(`${byId.get(id).file}: dependency loop ${[...loop.slice(loop.indexOf(dep)), dep].join(' -> ')}`);
      } else if (!mark.has(dep)) visit(dep, [...trail, id]);
    }
    mark.set(id, 2);
  };
  for (const t of tasks) if (!mark.has(t.id)) visit(t.id, []);
  return errors;
}

// { exists, tasks, errors }. tasks only holds valid files, in stable file-name order.
function readPlan(cfg) {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!names.length) return { exists: false, tasks: [], errors: [] };

  const tasks = [];
  const errors = [];
  for (const f of names) {
    const r = checkTask(path.join(DIR, f), cfg);
    errors.push(...r.errors);
    if (r.task) tasks.push(r.task);
  }
  errors.push(...checkGraph(tasks, new Set(names.map((f) => path.basename(f, '.md')))));
  return { exists: true, tasks, errors };
}

module.exports = { readPlan };
