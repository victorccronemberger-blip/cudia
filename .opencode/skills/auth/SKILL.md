---
name: auth
description: Test auth, sessions, JWT and OAuth.
metadata:
  version: "1"
  tools: http,browser
---
# Authentication & session testing playbook

Target the mechanisms that establish and carry identity. Impact here is usually
account takeover or privilege escalation.

## Focus areas
1. Credential flows: enumeration via timing/response deltas, weak lockout, password
   reset token predictability/reuse, host-header poisoning in reset links.
2. Sessions: fixation, missing rotation on privilege change, insecure cookie flags,
   overlong lifetimes, logout that does not invalidate server-side.
3. JWT: `alg=none`, HS/RS confusion, `kid` path traversal/injection, `jku`/`x5u`
   SSRF, weak HMAC secrets, missing expiry/audience checks.
4. OAuth/OIDC: redirect_uri validation, state/PKCE presence, token leakage via
   referrer, scope escalation, implicit-flow token exposure.
5. MFA: bypass via backup flows, response tampering, or step skipping.

## Method
Verify each issue end-to-end (forge a token, reuse a session, complete a takeover
of a test account). Keep it to accounts you control. Capture the exact tokens and
requests as evidence, with secrets redacted in the written report.
