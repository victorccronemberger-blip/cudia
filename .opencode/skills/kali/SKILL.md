---
name: kali
description: Investigate local native-code vulnerabilities, crashes, fuzzing results, or exploit-lab tasks.
metadata:
  version: "5"
---

# Local vulnerability research

Inventory the supplied source or binary version, build/compiler settings,
reproducer, actual runtime, and explicit success criterion. Discover missing
inputs in the authorized workspace; do not assume tools or a Kali Linux host.

Trace the failure to a root-cause hypothesis. Relevant areas include memory
lifetime, bounds, type confusion, races, parsing, and authorization. Select
installed inspection/debugging tools appropriate to the format. Record
mitigations such as ASLR, NX, canaries, RELRO, or sandboxing as observed
properties.

For requested reproduction, distinguish sanitizer findings, a local build,
and the actual target runtime. Preserve commands, inputs, traces, and failed
hypotheses. Fuzzing, exploit construction, and mitigation research are optional
methods for the requested objective, not mandatory stages. A crash or
root-cause report may satisfy it; a flag matters only when explicitly specified.
