---
description: Find matching GitHub issues in the current project
---

Search existing GitHub issues that match the supplied query. Treat
`$ARGUMENTS` as the query, optionally prefixed by an explicit `owner/repo`.

When a repository is not supplied, resolve the current project's GitHub
repository from `gh repo view` or its Git remotes. If the repository cannot be
resolved unambiguously, report that and ask for `owner/repo`; do not guess or
fall back to a fixed upstream. Search existing issues only. Do not create
issues, add comments, send messages, or change repository state.

Consider similar titles and descriptions, matching errors or symptoms, related
functionality, and related feature requests. List each useful match with its
number and title, a brief reason it matches, and a direct issue link. If no
clear matches are found, say so.
