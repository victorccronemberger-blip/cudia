---
name: llm
description: Trace instruction, retrieval, and tool trust boundaries in LLM applications.
metadata:
  version: "3"
---

# LLM application analysis

Trace untrusted inputs from prompts, retrieved documents, or model outputs to
tool arguments, data access, callbacks, rendering, and execution. Identify the
boundary intended to enforce each restriction; a model's refusal or compliance
alone does not prove the application's access controls.

For requested tests, use a controlled input and minimal observable marker,
then capture input, output or tool effect, and reproduction conditions. Keep
secrets out of reports and distinguish a hypothesis from a demonstrated
boundary crossing. Source review needs no live injection; test output remains
untrusted evidence.
