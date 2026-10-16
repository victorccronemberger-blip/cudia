---
description: Review AI SDK dependency updates for this project
---

Review the AI SDK and model-provider dependencies used by the current project.

Use `$ARGUMENTS` as optional scope or manifest paths. Otherwise, discover the
project's package manifests and workspace configuration from the current
project. Follow its package manager and lockfile; do not assume a particular
repository layout or package name.

Identify direct dependencies for AI SDKs and model providers, including
packages such as `ai`, `@ai-sdk/*`, and provider packages from other vendors.
For each one, report the declared version and, when a lockfile is available,
the resolved version. Find newer releases within the same major version and
respect the project's version ranges, package-manager rules, and prerelease
policy. Do not recommend a major upgrade.

For each eligible update, include the target version, a brief summary of
relevant changes, and a changelog or other authoritative reference when
available. Mark anything you could not verify. Include dependencies with no
eligible update so the report covers the full set you found.

Write the report to `ai-sdk-updates.md` in the project root unless the user
specifies another destination. Do not modify dependency manifests or lockfiles.
