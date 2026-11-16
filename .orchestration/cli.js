#!/usr/bin/env node
'use strict';
// Usage: node .orchestration/cli.js status | validate | approve TASK-001 [TASK-002...] | reject TASK-001 "reason" | reset | release-all
// validate: the Planner runs it before handing off to the Orchestrator; the hook applies the same checks on dispatch.
// approve only approves if verifyCommand (config.json) passes: a deterministic gate before the Validator's judgment.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const L = require('./hooks/lib');
const { readPlan } = require('./hooks/plan');

const [cmd, ...args] = process.argv.slice(2);
const cfg = L.getConfig();

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function status() {
  const plan = readPlan(cfg);
  const state = L.readState();
  console.log(`Active slots: ${Object.keys(state.slots).length}/${cfg.maxParallelSubagents}`);
  for (const t of plan.tasks) {
    const s = state.tasks[t.id] || {};
    const dur = s.durationMs ? ` ${(s.durationMs / 1000).toFixed(0)}s` : '';
    console.log(`${t.id}  cycle ${t.cycle}  ${(s.state || 'ready').padEnd(20)} attempts=${s.attempts || 0}${dur}  ${t.title}`);
  }
  if (plan.errors.length) console.log(`\n⚠ plan has ${plan.errors.length} error(s); run: node .orchestration/cli.js validate`);
}

function validate() {
  const plan = readPlan(cfg);
  if (!plan.exists) fail('no tasks in .orchestration/tasks/ (one TASK-XXX.md per task)');
  if (plan.errors.length) {
    for (const e of plan.errors) console.error(`✗ ${e}`);
    fail(`${plan.errors.length} error(s); dispatch stays blocked until they are fixed.`);
  }
  const cycles = new Set(plan.tasks.map((t) => t.cycle)).size;
  console.log(`✓ ${plan.tasks.length} valid task(s) in ${cycles} cycle(s)`);
}

function approve(ids) {
  if (!ids.length) fail('provide at least one id');
  const state = L.readState();
  for (const id of ids) {
    const st = state.tasks[id] && state.tasks[id].state;
    if (st !== 'awaiting_validation') fail(`${id} is "${st || 'ready'}"; only tasks in awaiting_validation can be approved.`);
  }
  console.log(`Running verification: ${cfg.verifyCommand}`);
  const r = spawnSync(cfg.verifyCommand, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) fail('verifyCommand failed: approval denied.');
  L.withState((s) => {
    for (const id of ids) Object.assign(s.tasks[id], { state: 'done', approvedAt: Date.now() });
  });
  L.log({ event: 'approved', taskIds: ids });
  console.log(`✓ approved: ${ids.join(', ')}`);
}

function reject(id, reason) {
  if (!id) fail('provide the id and the reason');
  L.withState((s) => {
    if (!s.tasks[id]) fail(`${id} has no state`);
    Object.assign(s.tasks[id], { state: 'rejected', reason: reason || '' });
  });
  L.log({ event: 'rejected', taskId: id, reason });
  console.log(`✓ ${id} rejected; back to the Orchestrator (attempts count toward maxAttempts).`);
}

switch (cmd) {
  case 'status': status(); break;
  case 'validate': validate(); break;
  case 'approve': approve(args); break;
  case 'reject': reject(args[0], args.slice(1).join(' ')); break;
  case 'release-all':
    L.withState((s) => { s.slots = {}; s.agents = {}; for (const t of Object.values(s.tasks)) if (t.state === 'in_progress') t.state = 'ready'; });
    console.log('✓ slots released'); break;
  case 'reset':
    fs.rmSync(L.FILES.state, { force: true });
    console.log('✓ state reset'); break;
  default:
    console.log('Usage: node .orchestration/cli.js status | validate | approve <ids...> | reject <id> "reason" | release-all | reset');
}
