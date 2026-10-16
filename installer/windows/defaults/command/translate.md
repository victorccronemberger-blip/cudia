---
description: Translate changed project documentation and interface copy
---

Review the Git changes and translate changed English documentation and
user-visible interface copy into the requested target locales. Use
`$ARGUMENTS` for explicit locales, file scope, or other constraints. When
locales are not specified, infer targets from the current project's existing
locale configuration and translated files. Do not assume a fixed language
catalog. If the project's target locales cannot be determined, report that
and ask which locales to use.

Preserve meaning, intent, tone, and Markdown/MDX structure. Keep technical
terms and artifacts exactly as written, including names, identifiers, code,
commands and flags, file paths, URLs, versions, error messages, and config
keys and values. Do not change inline code or fenced code blocks. Respect any
project glossary or locale guide that exists; locale-specific files such as
`.opencode/glossary/<locale>.md` are optional guidance, not required inputs.

Translate only the requested files and locales. Work through the scope
without launching unbounded parallel agents or loading unrelated catalogs.
