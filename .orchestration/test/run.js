#!/usr/bin/env node
'use strict';
// Smoke tests with simulated payloads. Runs on a temporary copy: never touches your real state.
// Usage: node .orchestration/test/run.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const src = path.resolve(__dirname, '..');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
const orch = path.join(ws, '.orchestration');
fs.cpSync(src, orch, {
  recursive: true,
  filter: (f) => !/[\\/](state\.json|logs|\.lock)([\\/]|$)/.test(f),
});
const hook = path.join(orch, 'hooks', 'hook.js');
const cli = path.join(orch, 'cli.js');

function exec(script, args, payload) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { cwd: ws });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(payload ? JSON.stringify({ cwd: ws, session_id: 's1', ...payload }) : '');
  });
}
const run = (event, payload) => exec(hook, [event], payload);
const pre = (tool, input, extra = {}) => run('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra });
const post = (tool, input, extra = {}) => run('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, ...extra });
const dispatch = (prompt, id, extra = {}) => pre('runSubagent', { prompt, description: 'x' }, { tool_use_id: id, ...extra });

let n = 0;
async function t(name, fn) {
  try { await fn(); n++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; throw e; }
}

(async () => {
  console.log('Plan (tasks/*.md)');
  const tasksDir = path.join(orch, 'tasks');
  const fm = (head, body = '## Goal\nx') => `---\n${head}\n---\n\n${body}\n`;
  const ok9 = 'id: TASK-009\ntitle: T\nallowed_paths: [src/x/**]';
  // Writes extra files into tasks/, runs fn and deletes them: every case starts from the example plan.
  async function withTasks(files, fn) {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(tasksDir, name), text);
    try { await fn(); } finally { for (const name of Object.keys(files)) fs.rmSync(path.join(tasksDir, name)); }
  }
  await t('validate accepts the example plan', async () => {
    const r = await exec(cli, ['validate']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /5 valid task\(s\) in 2 cycle\(s\)/);
  });
  await t('validate accepts CRLF, BOM and an unindented block list', async () => {
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}${fm('id: TASK-009\ntitle: "T: with a colon"\nallowed_paths:\n- src/x/**')}`.replace(/\n/g, '\r\n');
    await withTasks({ 'TASK-009.md': text }, async () => assert.equal((await exec(cli, ['validate'])).code, 0));
  });
  const broken = [
    ['line without a colon', { 'TASK-009.md': fm(`${ok9}\ncycle 2`) }, /TASK-009\.md:5: unrecognized line/],
    ['misspelled key', { 'TASK-009.md': fm(`${ok9}\ndepends-on: [TASK-001]`) }, /unknown key "depends-on"/],
    ['unclosed frontmatter', { 'TASK-009.md': '---\nid: TASK-009\n' }, /missing the closing ---/],
    ['id different from the file name', { 'TASK-009.md': fm(ok9.replace('TASK-009', 'TASK-010')) }, /does not match the file name/],
    ['no allowed_paths and empty body', { 'TASK-009.md': fm('id: TASK-009\ntitle: T', '') }, /allowed_paths must be[\s\S]*empty body/],
    ['non-numeric cycle', { 'TASK-009.md': fm(`${ok9}\ncycle: 1 # first`) }, /cycle must be an integer/],
    ['missing dependency', { 'TASK-009.md': fm(`${ok9}\ndepends_on: [TASK-404]`) }, /references TASK-404, which does not exist/],
    ['dependency on a later cycle', { 'TASK-009.md': fm(`${ok9}\ndepends_on: [TASK-005]`) }, /later than this task's cycle 1/],
    ['dependency loop', {
      'TASK-009.md': fm(`${ok9}\ndepends_on: [TASK-010]`),
      'TASK-010.md': fm('id: TASK-010\ntitle: T\nallowed_paths: [src/y/**]\ndepends_on: [TASK-009]'),
    }, /dependency loop TASK-009 -> TASK-010 -> TASK-009/],
  ];
  for (const [name, files, expected] of broken) {
    await t(`validate rejects: ${name}`, () => withTasks(files, async () => {
      const r = await exec(cli, ['validate']);
      assert.equal(r.code, 1);
      assert.match(r.err, expected);
    }));
  }
  await t('an invalid plan blocks dispatch with the same message as validate', async () => {
    await withTasks({ 'TASK-009.md': fm(`${ok9}\ndepends-on: []`) }, async () => {
      const r = await dispatch('Execute TASK-001', 'pv1');
      assert.equal(r.code, 2);
      assert.match(r.err, /Invalid plan[\s\S]*unknown key "depends-on"/);
    });
  });
  await t('without tasks/ a dispatch with an id is blocked; without an id it only takes a slot', async () => {
    fs.renameSync(tasksDir, `${tasksDir}.off`);
    try {
      assert.match((await dispatch('Execute TASK-001', 'pa1')).err, /Missing plan/);
      assert.equal((await dispatch('do something', 'pa2')).code, 0);
    } finally { fs.renameSync(`${tasksDir}.off`, tasksDir); }
  });
  await exec(cli, ['reset']);

  console.log('Concurrency');
  await t('6 simultaneous dispatches: exactly 3 pass and 3 are blocked', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => dispatch(`do something ${i}`, `par-${i}`)));
    assert.equal(rs.filter((r) => r.code === 0).length, 3);
    assert.equal(rs.filter((r) => r.code === 2).length, 3);
    assert.match(rs.find((r) => r.code === 2).err, /Limit of 3/);
  });
  await exec(cli, ['reset']);

  console.log('Dispatch, DAG and cycles');
  await t('TASK-001..003 pass', async () => {
    for (const i of [1, 2, 3]) assert.equal((await dispatch(`Execute TASK-00${i}`, `d${i}`)).code, 0);
  });
  await t('4th dispatch (TASK-004) is blocked by the limit', async () => {
    const r = await dispatch('Execute TASK-004', 'd4');
    assert.equal(r.code, 2);
    assert.match(r.err, /Limit of 3/);
  });
  await t('TASK-005 is blocked by dependency (the more informative reason comes before the limit)', async () => {
    const r = await dispatch('Execute TASK-005', 'd5');
    assert.equal(r.code, 2);
    assert.match(r.err, /depends on TASK-001, TASK-002/);
  });
  await t('re-dispatching a running task is blocked', async () => {
    assert.match((await dispatch('Execute TASK-001', 'dx')).err, /is already running/);
  });
  await t('a Validator mentioning an id does not become an implementation task', async () => {
    const r = await pre('runSubagent', { prompt: 'Validate TASK-001', agentName: 'Validator' }, { tool_use_id: 'v1' });
    assert.match(r.err, /Limit of 3/); // only takes a slot; no DAG/state check
  });

  console.log('Injected context (SubagentStart)');
  await t('the TASK-001 contract reaches the implementer, with scope and role', async () => {
    const r = await run('subagent-start', {
      hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Implementer', prompt: 'Execute TASK-001',
    });
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'SubagentStart');
    assert.match(ctx.additionalContext, /TASK-001/);
    assert.match(ctx.additionalContext, /src\/orders\/\*\*/);
    assert.match(ctx.additionalContext, /Pagination with limit and offset/); // body of the .md
    assert.match(ctx.additionalContext, /Role: Implementer/);
  });
  await t('the Validator only gets the role context, with no task contract', async () => {
    const r = await run('subagent-start', {
      hook_event_name: 'SubagentStart', agent_id: 'v1', agent_type: 'Validator', prompt: 'Validate TASK-001',
    });
    assert.doesNotMatch(r.out, /Task contract/);
  });

  console.log('Edit scope (PreToolUse)');
  const edit = (tool, input, agent = 'a1') => pre(tool, input, { agent_id: agent });
  await t('inside the scope passes', async () => {
    assert.equal((await edit('replace_string_in_file', { filePath: 'src/orders/list.ts', oldString: 'a', newString: 'b' })).code, 0);
    assert.equal((await edit('editFiles', { files: ['test/orders/list.test.ts'] })).code, 0);
    assert.equal((await edit('create_file', { filePath: `${ws}/.orchestration/reports/TASK-001.md` })).code, 0);
  });
  await t('outside the scope is blocked', async () => {
    assert.match((await edit('replace_string_in_file', { filePath: 'src/payments/pay.ts' })).err, /outside the scope of TASK-001/);
  });
  await t('apply_patch with a file outside the scope is blocked', async () => {
    const patch = '*** Begin Patch\n*** Update File: src/orders/a.ts\n@@\n-a\n+b\n*** Update File: src/payments/b.ts\n@@\n-a\n+b\n*** End Patch';
    assert.equal((await edit('apply_patch', { input: patch })).code, 2);
  });
  await t('hooks, config and .env are protected; ../ is refused', async () => {
    assert.match((await edit('create_file', { filePath: '.github/hooks/orchestration.json' })).err, /protected/);
    assert.match((await edit('create_file', { filePath: '.orchestration/config.json' })).err, /protected/);
    assert.match((await edit('create_file', { filePath: 'src/orders/.env.local' })).err, /protected/);
    assert.match((await edit('create_file', { filePath: '../outside.txt' })).err, /outside the workspace/);
  });

  console.log('Commands');
  await t('push --force and push to main are blocked; push to the task branch passes', async () => {
    assert.equal((await pre('run_in_terminal', { command: 'git push --force origin feat/x' })).code, 2);
    assert.equal((await pre('run_in_terminal', { command: 'git push -u origin main' })).code, 2);
    assert.equal((await pre('run_in_terminal', { command: 'git push origin feat/task-001-orders-endpoint' })).code, 0);
  });
  await t('the implementer cannot approve its own task; reset is human-only', async () => {
    const a = await pre('run_in_terminal', { command: 'node .orchestration/cli.js approve TASK-001' }, { agent_type: 'Implementer' });
    assert.match(a.err, /Only the Validator/);
    assert.match((await pre('run_in_terminal', { command: 'node .orchestration/cli.js reset' }, { agent_type: 'Validator' })).err, /human-only/);
  });

  console.log('Lifecycle and approval');
  await t('PostToolUse releases the slot and moves the task to awaiting_validation', async () => {
    await post('runSubagent', {}, { tool_use_id: 'd1' });
    const s = JSON.parse(fs.readFileSync(path.join(orch, 'state.json'), 'utf8'));
    assert.equal(s.tasks['TASK-001'].state, 'awaiting_validation');
    assert.equal((await dispatch('Execute TASK-004', 'd4b')).code, 0); // slot released
  });
  await t('approve fails if verifyCommand fails and passes if it passes', async () => {
    const cfgFile = path.join(orch, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, verifyCommand: 'node -e "process.exit(1)"' }));
    assert.equal((await exec(cli, ['approve', 'TASK-001'])).code, 1);
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, verifyCommand: 'node -e "process.exit(0)"' }));
    assert.equal((await exec(cli, ['approve', 'TASK-001'])).code, 0);
  });
  await t('TASK-005 stays blocked until TASK-002 is validated', async () => {
    assert.match((await dispatch('Execute TASK-005', 'd5b')).err, /depends on TASK-002/);
  });
  await t('SubagentStop releases the slot by agent_id (fallback)', async () => {
    await run('subagent-stop', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Implementer' });
    const s = JSON.parse(fs.readFileSync(path.join(orch, 'state.json'), 'utf8'));
    assert.ok(!Object.values(s.slots).some((x) => x.agentId === 'a1'));
  });
  await t('max attempts: the 3rd attempt at the same task is refused', async () => {
    await exec(cli, ['reset']);
    for (const id of ['r1', 'r2']) {
      assert.equal((await dispatch('Execute TASK-003', id)).code, 0);
      await post('runSubagent', {}, { tool_use_id: id });
      await exec(cli, ['reject', 'TASK-003', 'failed']);
    }
    assert.match((await dispatch('Execute TASK-003', 'r3')).err, /2 attempts/);
  });
  await t('an internal error in PreToolUse blocks (fail-closed)', async () => {
    fs.writeFileSync(path.join(orch, 'state.json'), '{ broken json');
    assert.equal((await dispatch('anything', 'z1')).code, 2);
  });

  console.log(`\n${n} tests ok. Test copy at ${ws}`);
})().catch(() => { process.exitCode = 1; });
