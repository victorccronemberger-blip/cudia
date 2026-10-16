---
description: Review requested changes for unnecessary generated-code patterns
---

Review the requested working changes and remove unnecessary generated-code
patterns that conflict with this project's conventions. Use `$ARGUMENTS` as
an optional base revision. If none is supplied, resolve the current branch's
upstream from Git metadata, then the repository's configured default remote
branch. Do not assume a branch name. Include staged and unstaged changes in
the review.

If no reliable base can be resolved, review the staged and unstaged diffs
with `git diff --cached` against `HEAD` and `git diff` against the index, and
review requested untracked files when their contents are available. State the
missing base and do not claim to have compared against the project base
branch.

Look for unnecessary comments, defensive checks that do not fit the trusted
code path, casts that hide type errors, inconsistent style, and other changes
that do not belong. Keep useful validation and behavior. Report the changes
you made in one to three sentences.
