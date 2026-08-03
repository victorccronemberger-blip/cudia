---
name: recon
description: Map an in-scope attack surface.
metadata:
  version: "1"
  tools: http,shell
---
# Recon playbook

Goal: enumerate the target's reachable surface before deeper testing.
Stay within the configured scope allow-list.

## Steps
1. Confirm scope. Enumerate hosts that resolve within the allow-list.
2. Discovery first: certificate transparency, DNS records, asset lists, and
   public sources. Prefer `http` GETs, then escalate to active probes as needed.
3. Resolve and probe candidate hosts for liveness (HTTP/HTTPS, status, title,
   server header). Record which are live.
4. Fingerprint technology: response headers, well-known paths (`/robots.txt`,
   `/sitemap.xml`, `/.well-known/`), framework cookies, error signatures.
5. Content discovery on live hosts: common paths, backup/config files, API roots.
   Throttle to the engagement rate limit.

## Output
Produce an inventory: host → {live?, scheme, status, tech, notable paths}.
Flag anything worth deeper testing and hand off to `web` or `api`.
Capture evidence (request + response summary) for every notable finding.
