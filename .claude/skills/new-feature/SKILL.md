---
name: new-feature
description: Implement a task from docs/TASKS.md or a v1 feature from docs/PRD.md end to end - plan, thin vertical slices, tests, definition of done, task list update. Use when the user asks to build a task (T-0NN) or a feature (F#).
argument-hint: '<task or feature id, e.g. T-004 or F2>'
---

# New feature: $ARGUMENTS

1. Find the task in docs/TASKS.md and its feature in PRD §05. Read only that task's section in docs/source/fixlibrary-fejlesztesi-terv.md (search for `#### <number>.`): current state, solution steps, acceptance criteria, tests, dependencies. Restate the goal, the acceptance criteria and the out-of-scope neighbours (PRD §07). Not in the PRD or TASKS: stop and ask whether to add it there first.
2. Check the dependencies ("Előtte") are ticked in docs/TASKS.md. If not, say so and ask.
3. Read docs/ARCHITECTURE.md (where code goes, boundaries, §06), docs/DESIGN_SYSTEM.md for UI, docs/SECURITY.md for IPC, files, processes, downloads or secrets.
4. Plan in plan mode, or present a plan: day-sized vertical slices (shared types → db or Python → pipeline/service → IPC → UI), files and tests per slice, risks. More than five files in a slice, or anything in ARCHITECTURE §08 (new dependency, table, binary, service): ask. Wait for approval.
5. Branch `feat/<id>-<slug>`.
6. Per slice: tests first for pipeline, shared and Python logic (Arrange-Act-Assert), implement, run tests and typecheck.
7. Finish: every acceptance criterion is observed or named as unmet; criteria that need the real test set or hardware are listed for me to run. Loading, empty and error states; 1024×640; the TASKS.md box ticked and moved to Done; docs updated if structure or decisions changed.
8. Suggest `/review-changes` before the pull request.
