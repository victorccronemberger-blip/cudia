---
name: web
description: Assess web rendering, origin boundaries, redirects, SSRF, and business logic.
metadata:
  version: "3"
---

# Web application boundaries

Trace browser rendering contexts and input-to-output encoding, origin checks,
CSRF defenses, URL/redirect handling, server-side fetch destinations, and
relevant business transitions. Use `api` for REST/GraphQL object or operation
authorization and `auth` for login, sessions, JWT, and OAuth mechanisms.

Source review can end with code-path evidence. For requested live checks,
establish a baseline and change one variable at a time using controlled
accounts or objects. Browser interactions require an enabled integration.
Record redirect destinations, observed behavior, and practical limits relevant
to the user's requested task.
