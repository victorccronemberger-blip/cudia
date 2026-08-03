---
name: api
description: Test REST and GraphQL APIs.
metadata:
  version: "1"
  tools: http
---
# API testing playbook

APIs expose object-level and function-level logic directly. Focus on authorization
and data-shape abuse.

## Steps
1. Discover the surface: OpenAPI/Swagger, GraphQL introspection, JS bundles,
   `/api`, `/v1`, `.well-known`. Enumerate methods, not just paths.
2. Object-level authz (BOLA): swap ids/UUIDs between two accounts; test sequential
   and guessable identifiers.
3. Function-level authz: call admin/privileged operations as a low-privilege user;
   try undocumented verbs (PUT/PATCH/DELETE) on read endpoints.
4. Mass assignment: add unexpected fields (`role`, `isAdmin`, `verified`) to
   create/update bodies and check if they persist.
5. Input validation: type confusion, oversized arrays, injection in filters/sort,
   GraphQL alias/batch/depth abuse.
6. Rate limits and idempotency: replay one-time operations; look for races.

## Output
For each endpoint: required auth, observed authz, and any deviation. Prove impact
with a minimal request pair (attacker vs victim) and capture evidence.
