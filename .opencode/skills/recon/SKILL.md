---
name: recon
description: Produce an attack-surface inventory for assets relevant to the user's request.
metadata:
  version: "3"
---

# Attack-surface inventory

Start from assets, documentation, and public sources relevant to the requested
inventory. Distinguish passive collection from active DNS, liveness, service, or
content checks. Select checks that fit the requested outcome and workload; use
installed tools rather than assuming scanner availability.

Record each asset, observed service or technology, source, timestamp, and
unresolved question. Note how discovered subdomains, providers, and redirects
relate to the supplied assets, and apply any target constraints the user gave.
Keep the inventory tied to observed evidence and the requested deliverable.
