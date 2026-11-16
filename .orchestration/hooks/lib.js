'use strict';
// Shared utilities for the hooks and the CLI: config, locked state, logging, globs, paths.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const ORCH = path.resolve(__dirname, '..'); // .orchestration/ folder (absolute: independent of cwd)
const FILES = {
  config: path.join(ORCH, 'config.json'),
  state: path.join(ORCH, 'state.json'),
  lock: path.join(ORCH, '.lock'),
  events: path.join(ORCH, 'logs', 'events.jsonl'),
  raw: path.join(ORCH, 'logs', 'raw.jsonl'),
};

// Defaults. Tool names vary by version/harness: confirm them with debug=true (README).
const DEFAULTS = {
  maxParallelSubagents: 3,
  slotTtlSeconds: 1800,
  maxAttempts: 2,
  taskIdPattern: 'TASK-\\d{3}',
  implementerAgents: ['implementer'],
  validatorAgents: ['validator'],
  subagentTools: ['runSubagent', 'agent', 'task'],
  editTools: [
    'editFiles', 'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
    'insert_edit_into_file', 'apply_patch', 'edit', 'write', 'create', 'str_replace',
  ],
  terminalTools: ['run_in_terminal', 'bash', 'shell', 'powershell'],
  protectedPaths: [
    '.github/hooks/**', '.orchestration/hooks/**', '.orchestration/cli.js',
    '.orchestration/config.json', '.orchestration/state.json', '**/.env*', '**/*.pem',
  ],
  alwaysAllowPaths: ['.orchestration/logs/**'],
  blockedCommands: [
    'git\\s+push\\b.*(--force|--force-with-lease|\\s-f\\b)',
    'git\\s+push\\b(\\s+-\\S+)*\\s+\\S+\\s+(\\S+:)?(main|master)\\b',
    'rm\\s+-rf\\s+(/|~|\\*)(\\s|$)',
    'curl[^|]*\\|\\s*(ba)?sh',
  ],
  strictPaths: false, // true = deny the edit when the path cannot be extracted from the payload
  failOpen: false, // true = an internal error in PreToolUse lets the call through (default: blocks)
  debug: false, // true = write the raw payload of every PreToolUse to logs/raw.jsonl
  logAllTools: true,
  inlineSkills: true,
  maxSkillChars: 6000,
  verifyCommand: 'npm test', // deterministic gate for `cli.js approve`
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Invalid JSON in ${path.relative(process.cwd(), file)}: ${e.message}`);
  }
}

function getConfig() {
  return { ...DEFAULTS, ...loadJson(FILES.config, {}) };
}

// ---------- log (JSONL) ----------
function appendLog(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch { /* logging never brings the hook down */ }
}
const log = (entry) => appendLog(FILES.events, { ts: new Date().toISOString(), ...entry });
const rawLog = (entry) => appendLog(FILES.raw, { ts: new Date().toISOString(), ...entry });

// ---------- locked state (parallel hooks compete for the same file) ----------
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withState(fn) {
  fs.mkdirSync(ORCH, { recursive: true });
  let locked = false;
  for (let i = 0; i < 200 && !locked; i++) {
    try {
      fs.mkdirSync(FILES.lock); // mkdir is atomic: whoever creates it first wins
      locked = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { // orphaned lock (dead process)
        if (Date.now() - fs.statSync(FILES.lock).mtimeMs > 10000) fs.rmdirSync(FILES.lock);
      } catch { /* another process already cleaned it up */ }
      sleep(20 + Math.floor(Math.random() * 20));
    }
  }
  if (!locked) throw new Error('could not acquire the state lock');
  try {
    const state = { slots: {}, agents: {}, tasks: {}, ...loadJson(FILES.state, {}) };
    const result = fn(state);
    const tmp = `${FILES.state}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILES.state); // atomic write
    return result;
  } finally {
    try { fs.rmdirSync(FILES.lock); } catch { /* already removed */ }
  }
}

const readState = () => ({ slots: {}, agents: {}, tasks: {}, ...loadJson(FILES.state, {}) });

// Removes forgotten slots (aborted agent, VS Code closed...) and returns the task to "ready".
function purge(state, cfg) {
  const limit = Date.now() - cfg.slotTtlSeconds * 1000;
  for (const [key, slot] of Object.entries(state.slots)) {
    if (slot.reservedAt >= limit) continue;
    delete state.slots[key];
    const t = slot.taskId && state.tasks[slot.taskId];
    if (t && t.state === 'in_progress') t.state = 'ready';
  }
}

// ---------- minimal glob: **, *, ? ----------
const reCache = new Map();
function globToRegExp(glob) {
  if (reCache.has(glob)) return reCache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`);
  reCache.set(glob, rx);
  return rx;
}
const anyMatch = (globs, rel) => globs.some((g) => globToRegExp(g).test(rel));

// ---------- paths ----------
const PATH_KEYS = /^(file_?path|path|file|files|uri|filename|target)$/i;

// Extracts paths from any tool_input shape (filePath, files[], apply_patch patch...).
function extractPaths(input) {
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (/^\*\*\* Begin Patch/m.test(v)) {
        for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(m[1].trim());
      } else if (key && PATH_KEYS.test(key)) out.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input, '');
  return [...out];
}

function toRel(root, p) {
  if (p.startsWith('file://')) p = fileURLToPath(p);
  const abs = path.resolve(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
}
const isOutside = (rel) => rel.startsWith('..') || path.isAbsolute(rel);

// ---------- input ----------
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8').trim();
  return s ? JSON.parse(s) : {};
}

// Accepts both shapes (PascalCase/snake_case from VS Code and camelCase from Copilot CLI).
function normalize(raw) {
  let input = raw.tool_input ?? raw.toolArgs ?? raw.toolInput ?? {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = { command: input }; }
  }
  return {
    raw,
    cwd: raw.cwd || process.cwd(),
    toolName: raw.tool_name || raw.toolName || '',
    toolInput: input,
    toolUseId: raw.tool_use_id || raw.toolUseId || null,
    agentId: raw.agent_id || raw.agentId || null,
    agentType: raw.agent_type || raw.agentType || raw.agent_name || raw.agentName || null,
  };
}

module.exports = {
  ORCH, FILES, DEFAULTS, loadJson, getConfig, log, rawLog, withState, readState, purge,
  anyMatch, extractPaths, toRel, isOutside, readStdin, normalize,
};
