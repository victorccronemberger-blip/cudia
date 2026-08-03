---
name: report
description: Write reproducible security reports.
metadata:
  version: "1"
  tools: file
---
# Reporting playbook

Convert evidence into a report a triager can reproduce and act on. Report
findings you have validated end-to-end.

## Structure per finding
1. Title: concise, impact-first.
2. Severity: with justification (CVSS optional) and realistic business impact.
3. Affected asset: exact URL/endpoint/parameter/version, in scope.
4. Summary: what the flaw is, in two or three sentences.
5. Steps to reproduce: numbered, copy-pasteable, minimal. Include exact requests
   and PoC payloads.
6. Evidence: request/response excerpts with secrets and unrelated PII redacted.
7. Impact: what an attacker gains; chain to a concrete outcome.
8. Remediation: specific, actionable fix.

## Discipline
- One issue per report; do not bundle.
- No speculation stated as fact; separate "confirmed" from "suspected".
- Reference stored evidence ids rather than pasting raw secrets.
- Prefer test accounts you control for demos; redact unrelated third-party PII.
