---
name: code-review
description: Trace reachable security defects in source or a change diff.
metadata:
  version: "3"
---

# Security source review

Trace entry points through trust boundaries to relevant sinks: database calls,
process execution, paths, deserialization, templates, HTTP clients, and
reflection. Check server-side authorization per operation and object; assess
secrets, cryptography, configuration, and dependencies in context.

Prioritize reachable defects with concrete triggering conditions. Cite
`file:line`, describe the path to realistic impact, state assumptions, and give
a minimal remediation. Distinguish source evidence from runtime behavior that
has not been tested. Include validation when it helps satisfy the requested
review.
