---
name: web
description: Test web apps for exploitable flaws.
metadata:
  version: "1"
  tools: http,browser
---
# Web application testing playbook

Test in-scope web targets for impactful, demonstrable vulnerabilities. Every
claim needs a reproducible proof-of-concept and a concrete impact statement.

## Priorities
1. Access control (IDOR/BOLA, forced browsing, function-level authz). Compare
   responses across two accounts / object ids.
2. Injection: SQL/NoSQL, command, template (SSTI), header/host injection. Prove
   with a clear marker, then escalate to impact PoC when the objective requires it.
3. SSRF where a parameter takes a URL or hostname; check for internal reachability
   and metadata endpoints within engagement targets.
4. Client-side: reflected/stored XSS, open redirect, CSRF on state-changing routes.
5. Business logic: quantity/price tampering, workflow bypass, race conditions.

## Method
- Establish a baseline authenticated request, then mutate one variable at a time.
- Use real exploit payloads and PoCs as needed for the objective. Prefer test
  accounts and objects you control for evidence capture.
- Record request, response, and the exact reproduction steps as evidence.
