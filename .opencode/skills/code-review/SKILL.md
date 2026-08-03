---
name: code-review
description: Review source code for security defects.
metadata:
  version: "1"
  tools: file,shell
---
# Security code review playbook

Read the code with the file tools and trace untrusted input to sensitive sinks.

## Approach
1. Map entry points (routes, handlers, jobs, CLI) and identify trust boundaries.
2. Follow tainted data to sinks: SQL/ORM, shell/exec, file paths, deserialization,
   template rendering, HTTP clients (SSRF), and reflection.
3. Authorization: is every sensitive operation gated, server-side, per-object?
   Look for missing checks, not just wrong ones.
4. Secrets & crypto: hardcoded keys, weak hashing for passwords, ECB/static IVs,
   custom crypto, tokens without expiry, secrets logged.
5. Configuration: debug modes, permissive CORS, disabled TLS verification, unsafe
   defaults, dependency versions with known CVEs.

## Output
Cite `file:line` for each issue, explain the exploit path, rate severity, and give
a minimal fix. Prefer a few high-confidence findings over noise. Distinguish
proven issues from suspicions and label them accordingly.
