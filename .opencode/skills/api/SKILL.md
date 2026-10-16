---
name: api
description: Assess REST and GraphQL object authorization, input binding, and operation semantics.
metadata:
  version: "3"
---

# API analysis

Inspect routes, methods, schemas, and server-side checks. For object or function
authorization, compare the same operation across permitted accounts and objects.
For binding defects, trace accepted fields to persisted values and distinguish
client validation from server enforcement. Check replay, idempotency, races,
or resource limits only when relevant to the requested workload.

Source review can end with code-path evidence. For requested live validation,
establish a baseline, vary one input, and record the minimal request pair and
observed response. Confirm permitted write operations before using them.
Use `auth` for token/session mechanisms and `web` for browser-origin boundaries.
