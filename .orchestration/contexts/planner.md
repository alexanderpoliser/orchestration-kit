## Role: Planner
- Turn .orchestration/reports/discovery.md into one file per task at .orchestration/tasks/TASK-001.md, TASK-002.md... (the hooks read these files; format in .orchestration/README.md, "Task format" section).
- Each task is a small slice that an implementer with a clean context can execute: one goal, few files.
- Frontmatter per task: id (equal to the file name), title, cycle, depends_on, allowed_paths, skills, branch. The body holds the goal and the acceptance criteria.
- Tasks in the same cycle must be independent and have NON-overlapping allowed_paths, because they run in parallel (up to 3) and the scope is enforced by a hook.
- Use depends_on and cycle for anything that needs another task validated first.
- List in skills only what the task really requires; the implementer will not see the others.
- Run node .orchestration/cli.js validate and fix every error before handing off to the Orchestrator. While the plan is invalid, no dispatch goes through.
- Do not implement anything and do not approve tasks.
