#!/usr/bin/env node
'use strict';
// Single entry point for the hooks: node .orchestration/hooks/hook.js <event>
// Block = exit code 2 + reason on stderr (the model receives the reason and can correct itself).
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const { readPlan } = require('./plan');

class Deny extends Error {}
const deny = (msg) => { throw new Deny(msg); };

// A missing or invalid plan blocks: the hook enforces exactly what `cli.js validate` checks.
function requirePlan(cfg) {
  const plan = readPlan(cfg);
  if (!plan.exists) deny('Missing plan: no tasks in .orchestration/tasks/. The Planner must create them before dispatching.');
  if (plan.errors.length) deny(`Invalid plan (run node .orchestration/cli.js validate):\n${plan.errors.join('\n')}`);
  return plan;
}

const matches = (names, tool) => names.some((n) => n.toLowerCase() === String(tool).toLowerCase());
const taskIdsIn = (text, cfg) => [...new Set(String(text).match(new RegExp(cfg.taskIdPattern, 'g')) || [])];
const isImplementer = (role, cfg) => !role || cfg.implementerAgents.some((n) => String(role).toLowerCase().includes(n));
const roleOfInput = (i) => String(i.agentName || i.agent_name || i.agent || i.subagent_type || i.subagentType || '').toLowerCase();

// Closes the slot and moves the task to "awaiting validation".
function finishSlot(state, slot) {
  const t = slot && slot.taskId && state.tasks[slot.taskId];
  if (t && t.state === 'in_progress') {
    t.state = 'awaiting_validation';
    t.finishedAt = Date.now();
    t.durationMs = t.finishedAt - (t.startedAt || slot.reservedAt);
  }
  return t;
}

function takeSlot(state, { key, agentId, allowOldest }) {
  let k = key && state.slots[key] ? key : null;
  if (!k && agentId) k = Object.keys(state.slots).find((x) => state.slots[x].agentId === agentId) || null;
  if (!k && !key && allowOldest) {
    k = Object.keys(state.slots).sort((a, b) => state.slots[a].reservedAt - state.slots[b].reservedAt)[0] || null;
  }
  if (!k) return null;
  const slot = state.slots[k];
  delete state.slots[k];
  return { key: k, ...slot };
}

// ---------------- PreToolUse ----------------
function onPreToolUse(p, cfg) {
  if (cfg.debug) L.rawLog({ hook: 'pre-tool-use', payload: p.raw });
  if (matches(cfg.subagentTools, p.toolName)) return guardDispatch(p, cfg);
  if (matches(cfg.editTools, p.toolName)) return guardEdit(p, cfg);
  if (matches(cfg.terminalTools, p.toolName)) return guardCommand(p, cfg);
}

// Subagent dispatch: DAG, cycle, attempts and parallelism limit (atomic under the lock).
function guardDispatch(p, cfg) {
  const ids = taskIdsIn(JSON.stringify(p.toolInput || {}), cfg);
  const taskId = ids.length === 1 && isImplementer(roleOfInput(p.toolInput), cfg) ? ids[0] : null;
  const plan = taskId ? requirePlan(cfg) : null;

  L.withState((state) => {
    L.purge(state, cfg);
    const stateOf = (id) => (state.tasks[id] && state.tasks[id].state) || 'ready';
    let prev = null;

    if (taskId) {
      const task = plan.tasks.find((t) => t.id === taskId);
      if (!task) deny(`${taskId} does not exist in .orchestration/tasks/.`);
      prev = state.tasks[taskId] || { state: 'ready', attempts: 0 };
      if (prev.state === 'in_progress') deny(`${taskId} is already running.`);
      if (prev.state === 'awaiting_validation') deny(`${taskId} has finished and is awaiting the Validator.`);
      if (prev.state === 'done') deny(`${taskId} has already been validated.`);
      if ((prev.attempts || 0) >= cfg.maxAttempts) {
        deny(`${taskId} has reached ${cfg.maxAttempts} attempts. Send it back to the Planner to replan or escalate the model.`);
      }
      const pending = task.depends_on.filter((d) => stateOf(d) !== 'done');
      if (pending.length) deny(`${taskId} depends on ${pending.join(', ')}, not yet validated.`);
      const earlier = plan.tasks.filter((t) => t.cycle < task.cycle && stateOf(t.id) !== 'done').map((t) => t.id);
      if (earlier.length) deny(`Cycle ${task.cycle} is blocked: ${earlier.join(', ')} from earlier cycles still need validation.`);
    }

    const active = Object.keys(state.slots).length;
    if (active >= cfg.maxParallelSubagents) {
      deny(`Limit of ${cfg.maxParallelSubagents} parallel subagents reached (${active} active). Wait for them to finish and dispatch the rest in the next batch.`);
    }

    const key = p.toolUseId || `anon-${Date.now()}-${process.pid}`;
    state.slots[key] = { taskId, agentId: null, reservedAt: Date.now() };
    if (taskId) {
      state.tasks[taskId] = { ...prev, state: 'in_progress', attempts: (prev.attempts || 0) + 1, startedAt: Date.now() };
    }
    L.log({ event: 'dispatch', taskId, slot: key, active: active + 1 });
  });
}

// Edit scope: the agent only writes to its task's allowed_paths (+ its own report).
function activeScope(p, state, cfg) {
  const mapped = p.agentId && state.agents[p.agentId];
  const ids = mapped
    ? [mapped]
    : Object.entries(state.tasks).filter(([, t]) => t.state === 'in_progress').map(([id]) => id);
  if (!ids.length) return null; // nothing running (e.g. the Planner): only the protected list applies
  const plan = requirePlan(cfg);
  const globs = [];
  for (const id of ids) {
    const task = plan.tasks.find((t) => t.id === id);
    globs.push(...((task && task.allowed_paths) || []), `.orchestration/reports/${id}*`);
  }
  return { ids, globs };
}

function guardEdit(p, cfg) {
  const files = L.extractPaths(p.toolInput);
  if (!files.length) {
    L.log({ event: 'edit_paths_unparsed', tool: p.toolName, input: JSON.stringify(p.toolInput).slice(0, 300) });
    if (cfg.strictPaths) deny(`Could not identify the file for ${p.toolName}; blocked (strictPaths=true).`);
    return;
  }
  const scope = activeScope(p, L.readState(), cfg);
  for (const f of files) {
    const rel = L.toRel(p.cwd, f);
    if (L.isOutside(rel)) deny(`Path outside the workspace: ${f}`);
    if (L.anyMatch(cfg.protectedPaths, rel)) deny(`${rel} is protected by policy and cannot be changed by agents.`);
    if (scope && !L.anyMatch([...scope.globs, ...cfg.alwaysAllowPaths], rel)) {
      deny(`${rel} is outside the scope of ${scope.ids.join(', ')}. Allowed: ${scope.globs.join(', ')}`);
    }
  }
}

function guardCommand(p, cfg) {
  const i = p.toolInput;
  const cmd = String(i.command || i.cmd || i.input || '');
  for (const pattern of cfg.blockedCommands) {
    if (new RegExp(pattern, 'i').test(cmd)) deny(`Command blocked by policy: /${pattern}/`);
  }
  if (/\.orchestration[\\/]+cli\.js\s+(reset|release-all)\b/i.test(cmd)) {
    deny('reset/release-all are human-only operations: run them in your own terminal, not through an agent.');
  }
  if (/\.orchestration[\\/]+cli\.js\s+(approve|reject)\b/i.test(cmd)) {
    const role = String(p.agentType || '').toLowerCase();
    if (role && !cfg.validatorAgents.some((n) => role.includes(n))) {
      deny('Only the Validator can approve or reject tasks.');
    }
  }
}

// ---------------- PostToolUse ----------------
function onPostToolUse(p, cfg) {
  if (matches(cfg.subagentTools, p.toolName)) {
    L.withState((state) => {
      const slot = takeSlot(state, { key: p.toolUseId, agentId: p.agentId, allowOldest: true });
      const t = finishSlot(state, slot);
      L.log({ event: 'subagent_done', taskId: slot && slot.taskId, durationMs: t && t.durationMs, slot: slot && slot.key });
    });
  } else if (cfg.logAllTools) {
    L.log({ event: 'tool', tool: p.toolName, agentId: p.agentId, agentType: p.agentType });
  }
}

// ---------------- SubagentStart: injects context (cannot block) ----------------
function onSubagentStart(p, cfg) {
  const ids = taskIdsIn(JSON.stringify(p.raw), cfg);
  let taskId = null;
  let strategy = 'none';

  L.withState((state) => {
    L.purge(state, cfg);
    if (isImplementer(p.agentType, cfg)) {
      if (ids.length === 1) { taskId = ids[0]; strategy = 'payload'; }
      else {
        // No id in the payload: only bind if there is exactly ONE unowned slot (never guess in parallel).
        const unbound = Object.values(state.slots).filter((s) => s.taskId && !s.agentId);
        if (unbound.length === 1) { taskId = unbound[0].taskId; strategy = 'single-unbound-slot'; }
      }
    }
    if (taskId && p.agentId) {
      state.agents[p.agentId] = taskId;
      const slot = Object.values(state.slots).find((s) => s.taskId === taskId && !s.agentId);
      if (slot) slot.agentId = p.agentId;
    }
  });

  const task = taskId ? readPlan(cfg).tasks.find((t) => t.id === taskId) : null;
  const context = buildContext(p, cfg, task);
  L.log({ event: 'subagent_start', agentId: p.agentId, agentType: p.agentType, taskId: task && task.id, strategy, chars: context.length });
  if (context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context },
    }));
  }
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function buildContext(p, cfg, task) {
  const parts = [];
  const role = String(p.agentType || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const roleCtx = readIfExists(path.join(L.ORCH, 'contexts', `${role}.md`)) || readIfExists(path.join(L.ORCH, 'contexts', 'default.md'));
  if (roleCtx) parts.push(roleCtx);

  if (task) {
    const lines = [
      `## Task contract ${task.id}: ${task.title}`,
      `You may only change: ${task.allowed_paths.join(', ')} and .orchestration/reports/${task.id}.md`,
      'A hook blocks writes outside this scope; do not waste time trying.',
      task.branch ? `Delivery: commit + push only to branch ${task.branch}.` : '',
      `When done, write the report to .orchestration/reports/${task.id}.md (what changed, files, tests and result).`,
    ].filter(Boolean);
    parts.push(`${lines.join('\n')}\n\n${task.body}`);

    for (const skill of task.skills) {
      const rel = L.toRel(p.cwd, skill);
      const body = !L.isOutside(rel) && cfg.inlineSkills ? readIfExists(path.join(p.cwd, rel)) : '';
      parts.push(body
        ? `## Skill: ${skill}\n${body.slice(0, cfg.maxSkillChars)}`
        : `## Skill: read ${skill} (only this one, for this task)`);
    }
  }
  return parts.join('\n\n');
}

// ---------------- SubagentStop: fallback slot release + telemetry ----------------
function onSubagentStop(p) {
  L.withState((state) => {
    const slot = p.agentId ? takeSlot(state, { agentId: p.agentId }) : null;
    const t = finishSlot(state, slot);
    if (p.agentId) delete state.agents[p.agentId];
    L.log({ event: 'subagent_stop', agentId: p.agentId, agentType: p.agentType, taskId: slot && slot.taskId, durationMs: t && t.durationMs });
  });
}

const handlers = {
  'pre-tool-use': onPreToolUse,
  'post-tool-use': onPostToolUse,
  'subagent-start': onSubagentStart,
  'subagent-stop': onSubagentStop,
};

async function main() {
  const event = process.argv[2];
  const handler = handlers[event];
  if (!handler) { process.stderr.write(`[orchestration] unknown event: ${event}\n`); process.exitCode = 1; return; }
  const cfg = L.getConfig();
  let p;
  try {
    p = L.normalize(await L.readStdin());
    await handler(p, cfg);
  } catch (err) {
    if (err instanceof Deny) {
      L.log({ event: 'deny', hook: event, tool: p && p.toolName, agentId: p && p.agentId, reason: err.message });
      process.stderr.write(`[orchestration] ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    L.log({ event: 'hook_error', hook: event, error: String((err && err.stack) || err) });
    if (event === 'pre-tool-use' && !cfg.failOpen) {
      process.stderr.write(`[orchestration] internal error, blocked for safety (failOpen=false): ${err.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`[orchestration] error in hook ${event}: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

main();
