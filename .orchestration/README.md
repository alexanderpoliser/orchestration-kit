# Hook-based orchestration kit (VS Code + GitHub Copilot, Node.js)

Hooks with no external dependencies (Node 18+). What the code enforces, instead of asking for it in the prompt:

| Rule | Where |
|---|---|
| Max. 3 parallel subagents (atomic, with a lock) | PreToolUse on dispatch |
| Valid plan (format, ids, dependencies, loops) before any dispatch with an id | `cli.js validate` and PreToolUse |
| A task only dispatches once its `depends_on` and earlier cycles are validated | PreToolUse on dispatch |
| Max. attempts per task (`maxAttempts`) | PreToolUse on dispatch |
| The implementer only writes to its task's `allowed_paths` | PreToolUse on edit tools |
| Hooks, config and `.env` protected; push to main/force blocked | PreToolUse |
| Task contract + skills injected into the subagent | SubagentStart |
| Approval only passes if `verifyCommand` (e.g. `npm test`) passes | `cli.js approve` |
| Per-task telemetry in JSONL (duration, slots, blocks) | `logs/events.jsonl` |

## Installation

1. Copy `.github/hooks/` and `.orchestration/` to the repository root.
2. Add to `.gitignore`:
   ```
   .orchestration/state.json
   .orchestration/.lock
   .orchestration/logs/
   ```
3. Run `node .orchestration/test/run.js` (it uses a temporary copy and never touches your state).
4. In VS Code, check the Output panel, **GitHub Copilot Chat Hooks** channel, to confirm the 4 hooks loaded. Hooks are still in preview and vary between the Local, Copilot and Claude harnesses.

## First use: confirm the real names (important)

Tool names and payload fields vary by version. The defaults in `config.json` are the most likely ones, but **they have not been verified on your installation**.

1. Set `"debug": true` in `config.json`.
2. Run a short flow (one dispatch and one edit).
3. Read `.orchestration/logs/raw.jsonl` and adjust `subagentTools`, `editTools` and `terminalTools`.
4. Look for `edit_paths_unparsed` in `events.jsonl`. If it shows up, the hook could not find the file path; adjust, or use `"strictPaths": true`, which blocks in those cases.
5. Turn debug off.

## Flow

- The **Planner** writes one file per task in `.orchestration/tasks/` (format below) and runs `node .orchestration/cli.js validate` until it passes.
- The **Orchestrator** dispatches with the id in the call (e.g. `Execute TASK-001`). One id per implementer dispatch.
- Each implementer finishes and the hook marks the task as `awaiting_validation`.
- The **Validator** runs `node .orchestration/cli.js approve TASK-001 TASK-002` or `reject TASK-003 "reason"`.
- `node .orchestration/cli.js status` shows the dashboard. `release-all` and `reset` are for you, in your own terminal.

## Task format

One file per task, named after its id: `.orchestration/tasks/TASK-001.md`. The header holds what the hook enforces; the body goes to the implementer in full and is what the Validator checks against.

```markdown
---
id: TASK-005
title: End-to-end integration
cycle: 2
depends_on: [TASK-001, TASK-002]
allowed_paths:
  - src/integration/**
  - test/integration/**
skills:
  - .github/skills/rest-endpoints/SKILL.md
branch: feat/task-005-integration
---

## Goal
Wire together the endpoint, validation and publishing.

## Acceptance criteria
- Create order -> event flow covered by a test
```

- Required: `id`, `title`, `allowed_paths` (non-empty list) and a non-empty body. `cycle` defaults to 1; `depends_on`, `skills` and `branch` are optional.
- The header is a strict YAML subset: `key: value`, `key: [a, b]`, or `key:` followed by `- item` lines. End-of-line comments are not supported.
- `validate` rejects unknown keys (e.g. `depends-on`), an id that differs from the file name, missing dependencies, dependencies on a later cycle (it would never dispatch) and dependency loops. Each error reports the file and line.
- The hook applies the same checks. While the plan is invalid, no dispatch with an id goes through, and edits by running tasks stay blocked until it is fixed.

## Known limits (read this)

- **SubagentStart cannot block**, it only injects context. The limit is enforced in the dispatch PreToolUse.
- **A hook timeout lets the call through.** That is why PreToolUse is fast (~30 ms) and fails closed on internal errors (`failOpen: false`).
- **Agent → task binding depends on the payload.** If `SubagentStart` carries neither the task id nor `agent_id`, the contract is only injected when there is exactly one unowned slot; otherwise the agent only gets the role context. The edit scope falls back to the union of running tasks (looser, but safe).
- **Writes through the shell** (`sed -i`, `echo >`) bypass the edit guard.
- **Who approves** is only checked if the payload carries the agent type; without it, any agent can call `approve` (`verifyCommand` still applies).
- **Credits are not in the hook payload.** The log has duration and counts per task; you match real credits against the GitHub usage dashboard, by day and by model.
- Forgotten slots (aborted agent) expire after `slotTtlSeconds` (30 min).
