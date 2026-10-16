---
description: Commit and push the requested project changes
subtask: true
---

Commit and push the changes requested in the current task. Respect the
project's `AGENTS.md`, contribution guide, and existing commit conventions.
Inspect the worktree, index, and requested scope before staging anything.
Stage only files that belong to this task, preserving unrelated staged and
unstaged changes. If the intended scope is unclear, report what is unclear
before changing the index. Do not discard or overwrite user changes.

Use a concise commit message that explains the user-facing reason for the
change. If the project requires a prefix or scope, follow its convention. If
there are conflicts, do not resolve them; report them for the operator.
After creating the commit, push the current branch to its configured upstream.
If no upstream is configured or the push fails, report the exact issue and
leave the commit intact.

## GIT DIFF

!`git diff`

## GIT DIFF --cached

!`git diff --cached`

## GIT STATUS --short

!`git status --short`
