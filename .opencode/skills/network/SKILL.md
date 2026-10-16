---
name: network
description: Build reproducible HTTP requests when methods, headers, bodies, or redirects matter.
metadata:
  version: "3"
---

# HTTP request mechanics

Use `webfetch` for supported retrieval. For controlled methods, headers,
bodies, or precise response evidence, use an installed HTTP client through
`bash` if available. Record the method, destination, relevant headers and body,
status, and response excerpt. Handle credentials according to the task's
reporting needs.

Follow redirects when they help complete the requested outcome, and record
their destinations when relevant. Apply any rate limits or state-change
constraints the user provided; note state changes and response evidence.
Use `api`, `auth`, or `web` for application-specific analysis; this skill
covers transport and reproducible requests.
