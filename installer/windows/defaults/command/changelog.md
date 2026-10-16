---
description: Create a user-focused changelog from Git history
---

Create `UPCOMING_CHANGELOG.md` from the Git commits in the requested range.
Use `$ARGUMENTS` as optional Git revision references or scope. If a range is
provided, honor it exactly. Otherwise, inspect the repository's tags and
upstream branch to identify the commits since the latest suitable release
boundary. If no reliable boundary exists, use the most recent 10 commits and
state the range used in your response. Do not run project-specific scripts or
assume a particular language runtime.

Inspect the real diff for every commit you keep with `git show --stat
--format='' <hash>` or `git show --format='' <hash>`. Do not use author metadata
to decide attribution. Include only user-facing changes; omit work that is
entirely internal, test-only, or otherwise not notable to users.

Use release sections only when they fit the project and contain an entry.
Group fixes under `### Bugfixes`; group other notable changes under
`### Improvements` when a section has both kinds. Write one concise bullet per
commit, lead with the user-visible outcome, and omit empty sections. Preserve
existing contributor attributions only when the supplied input contains them;
never infer names from Git metadata. If nothing notable remains, write exactly
`No notable changes.`

If `$ARGUMENTS` includes structured changelog input, use its release sections
and contributor block as the source of candidate commits and preserve the
contributor block verbatim. Do not fetch unrelated releases, pull requests, or
other external data to expand the requested range.
