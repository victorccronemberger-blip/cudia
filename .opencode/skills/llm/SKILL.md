---
name: llm
description: Test LLM apps for injection and tool abuse.
metadata:
  version: "1"
  tools: http,browser
---
# LLM application testing playbook

Assess features that route untrusted input through a model or its tools. The core
risk is that data becomes instructions.

## Focus areas
1. Direct prompt injection: instruction override, role/system-prompt disclosure,
   guardrail bypass.
2. Indirect injection: payloads embedded in fetched pages, files, or retrieved
   documents that the model later reads as instructions.
3. Tool/function abuse: coercing the app into unintended tool calls (SSRF via a
   fetch tool, file access, privileged actions) through crafted input.
4. Data exfiltration: leaking system prompts, other users' data, secrets, or
   embeddings via crafted queries or markdown/image callbacks.
5. Output-handling flaws: model output rendered as HTML/markdown leading to XSS,
   or trusted downstream execution of model-produced code/SQL.

## Method
Treat all model output as untrusted. Demonstrate a concrete boundary crossing
(e.g., the app performs an action the user should not be able to trigger). Craft
working injection and tool-abuse payloads; capture the full input/output exchange
as evidence.
