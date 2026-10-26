---
name: understand-chat
description: Use when you need to ask questions about a codebase or understand code using a knowledge graph
---

# understand-chat (CUDIA optional workflow)

Use this skill only when the user requests its workflow. It is an invoke-only
loader for the complete, pinned Understand Anything 2.9.7 plugin, commit
`e24fcf6d371bcfa529bc110bacb1bb43de1b8d33`.

1. Resolve the read-only defaults directory from `CUDIA_DISTRIBUTION_DIR`. The
   native launcher sets that variable directly to `defaults`; if it instead
   identifies a distribution root, use its `defaults` child. Never discover,
   overwrite or install into an existing global Understand Anything checkout.
2. Run this PowerShell preflight and bootstrap only for this invocation:

   ```powershell
   $defaults = $env:CUDIA_DISTRIBUTION_DIR
   if (-not $defaults) { throw 'Launch this optional skill from the installed CUDIA distribution.' }
   $bootstrap = Join-Path $defaults 'addons\understand-anything\bootstrap.ps1'
   if (-not (Test-Path -LiteralPath $bootstrap)) {
     $bootstrap = Join-Path $defaults 'defaults\addons\understand-anything\bootstrap.ps1'
   }
   if (-not (Test-Path -LiteralPath $bootstrap)) { throw 'Understand Anything optional assets are missing. Reinstall CUDIA with its optional assets payload.' }
   $runtime = & $bootstrap -Skill understand-chat -RequirePrerequisites | ConvertFrom-Json
   Get-Content -Raw -LiteralPath $runtime.SkillFile
   ```

   If preflight reports required missing tools for this workflow, report that concrete
   prerequisite and stop this optional workflow. Full understand requires Git and Python; diff requires Git. Other workflows can use existing graphs without either tool, and check any additional tool only at the step that needs it. Core CUDIA remains usable. Do
   not install unrelated prerequisites or silently replace the locked packages.
   First initialization needs network access to npm; later use reuses a private,
   versioned cache. Node and pnpm are bundled; a global Node installation is not
   needed. Do not execute this loader at startup or merely when listing skills.
3. Read and follow the actual upstream skill at `runtime.SkillFile`, and resolve
   `SKILL_DIR` as the parent directory of `runtime.SkillFile`; resolve skill-local helpers and references there, and plugin packages/agents from `runtime.PluginRoot`. Keep the
   complete plugin layout intact: helpers import packages relative to themselves.
   Translate Bash examples to PowerShell where appropriate. In every command
   that needs plugin discovery set `CLAUDE_PLUGIN_ROOT` to `runtime.PluginRoot`
   for that command process. Use the returned absolute `NodePath` for Node and
   `& $runtime.NodePath $runtime.PnpmPath <arguments>` for pnpm. These values must
   be supplied in each new tool shell; do not assume shell state persists.
4. Initialization already installed the frozen dependencies with lifecycle
   scripts disabled and built core. Skip upstream install/build preflight steps;
   never run an unpinned install fallback. For a requested dashboard, run the
   source's installed local Vite binary using `NodePath`, `GRAPH_DIR` and
   `--host 127.0.0.1`. Skip the upstream `npx` download fast path. Keep the access
   token in the reported dashboard URL and use hidden background windows.
5. Do not enable auto-update, file watchers, commit hooks, scheduled jobs or
   automatic analysis unless the user explicitly requests that feature. Do not
   prepend these skill instructions to the global system prompt. Explain any
   failure using its actual evidence; never claim a full workflow completed
   merely because this loader or a parser smoke test succeeded.
