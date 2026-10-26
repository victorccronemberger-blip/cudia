# Optional Understand Anything skills

This payload exposes nine explicitly invoked skills from Understand Anything 2.9.7,
commit `e24fcf6d371bcfa529bc110bacb1bb43de1b8d33` (MIT). It contains the complete
upstream source archive: skill helpers, language/framework references, agents,
core, dashboard, WASM workspace packages, lockfiles and upstream LICENSE.
The Node.js 22.23.4 executable and pnpm 10.6.2 distribution are bundled with their
licenses. `inputs.json` freezes original URLs and SHA-256 hashes; `manifest.json`
freezes every prepared file. The Node hash was checked against the official
`https://nodejs.org/dist/v22.23.4/SHASUMS256.txt`.

## Release preparation

Run with Windows PowerShell 5.1 or later on a packaging machine with `tar.exe`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/windows/addons/understand-anything/prepare.ps1 -OutputPath C:\release\ua-assets
```

`OutputPath` must not exist. Optional `-DownloadsPath` reuses already downloaded
inputs only after hash verification. Pass the resulting output directory to the
Windows packager's `-OptionalAssetsPath`. Its layout is exactly
`addons/understand-anything/*`, relative to the distribution defaults root.
The preparation script prints the absolute path, file count and byte count.
Never package the local test cache or `node_modules`.

## Invocation and prerequisites

Nothing is installed, started or analyzed during CUDIA startup. The shipped skill
wrappers resolve `CUDIA_DISTRIBUTION_DIR` (the launcher's defaults directory), call
this bootstrap and then read the actual pinned upstream `SKILL.md`. Global user
Understand Anything clones and skill junctions are neither discovered nor changed.

```powershell
& "$env:CUDIA_DISTRIBUTION_DIR\addons\understand-anything\bootstrap.ps1" -Skill understand -CheckOnly
& "$env:CUDIA_DISTRIBUTION_DIR\addons\understand-anything\bootstrap.ps1" -Skill understand -RequirePrerequisites
```

Full `/understand` analysis requires Git for Windows and Python 3, with working
`git.exe` and `python.exe`, `python3.exe` or `py.exe` commands. `/understand-diff`
requires Git. Dashboard, chat and explanation of an existing graph are not
blocked by missing Git/Python. Other workflows check prerequisites at the actual
step that needs them. A Windows Store Python alias is not accepted as an installed
interpreter. `-RequirePrerequisites` gates only the selected workflow's known
requirements before dependency installation. Core CUDIA requires neither Git,
Python nor Node.js. `-CheckOnly` verifies assets and reports both all missing
tools and the selected workflow's required missing tools, without writing a cache
or accessing the network.

First initialization needs network access to the npm registry and writes to
`%LOCALAPPDATA%\CUDIA\addons\understand-anything\<version-and-manifest-hash>`,
or an explicit `-CacheRoot`. It copies the bundled Node runtime, extracts the
complete pinned source and pnpm distribution, installs the upstream frozen
lockfile with **all lifecycle scripts disabled**, then runs only the upstream
core TypeScript compiler. No native dependency build is allowed. Existing WASM
grammars shipped in the locked packages support the tested parser path. No
Git clone, global package installation, persistent PATH change, scheduled job,
commit hook or automatic graph analysis runs. Failed downloads can be retried.

Bootstrap prints JSON containing `PluginRoot`, `SkillFile`, `NodePath`, `PnpmPath`
and `RuntimeBin`. Use these explicit paths in subsequent shell calls. If an
upstream command needs `node` or `pnpm` on PATH, set PATH only for that command's
process; call pnpm as `& $NodePath $PnpmPath <arguments>` in PowerShell. Use
PowerShell equivalents of upstream Bash snippets. Use `PluginRoot` as
`CLAUDE_PLUGIN_ROOT` only in the invoked workflow's command process; upstream
helpers remain in their real source directories so relative imports resolve.

For the dashboard, use the installed source and its local Vite binary with the
bundled Node runtime; omit upstream's optional `npx` release download fast path.
Bind to `127.0.0.1` and preserve its tokenized URL. Start the dashboard only when
requested. Any background process must use a hidden window on Windows.

## Validation and limits

An isolated frozen install using pnpm 10.6.2 with `--ignore-scripts`, explicit core
build and deterministic TypeScript structure extraction passed on Windows.
The complete bootstrap is also checked under Windows PowerShell 5.1 with a new
cache, and missing-prerequisite detection is checked with a restricted PATH.
No LLM analysis, Figma API access or complete nine-skill workflow acceptance test
is implied. The install is not fully offline: npm dependencies are fetched on
first use, and Git/Python remain separately installed optional prerequisites.
Cache dependencies may occupy substantially more disk space than release assets.
For an incomplete cache, choose a new `-CacheRoot`; no user cache is deleted.
