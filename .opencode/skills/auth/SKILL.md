---
name: auth
description: Review login, recovery, session lifecycle, JWT validation, and OAuth flows.
metadata:
  version: "3"
---

# Authentication and sessions

Trace the relevant transitions: login/recovery, session rotation and expiry,
MFA recovery, or privilege changes. For JWT, inspect algorithm selection,
key trust, issuer/audience, and expiry validation. For OAuth, inspect redirect
matching, state binding, PKCE, and callback-to-session handling.

Use code paths for source conclusions. Requested live checks need permitted
test accounts and a baseline: distinguish token rejection from application
errors, and capture redacted request/response evidence. Establish the requested
behavior without changing unrelated users' sessions. API object authorization
belongs to `api`; rendered login interactions need an enabled browser integration.
