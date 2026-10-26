#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('understand','understand-chat','understand-dashboard','understand-diff','understand-domain','understand-explain','understand-figma','understand-knowledge','understand-onboard')]
  [string]$Skill = 'understand',
  [string]$CacheRoot,
  [switch]$CheckOnly,
  [switch]$RequirePrerequisites
)
$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $PSScriptRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Understand Anything optional assets are missing. Reinstall CUDIA with the optional assets payload.' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -ne 'win-x64') { throw 'Unsupported Understand Anything optional assets manifest.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This optional Understand Anything runtime requires 64-bit Windows.' }
foreach ($asset in $manifest.files) {
  if ($asset.file -ne [IO.Path]::GetFileName($asset.file)) { throw 'Invalid optional asset filename.' }
  $assetPath = Join-Path $PSScriptRoot $asset.file
  if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) { throw "Missing optional asset: $($asset.file)" }
  if ((Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash -ne $asset.sha256) { throw "Optional asset hash mismatch: $($asset.file)" }
}
$missing = @()
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { $missing += 'Git for Windows (git.exe)' }
$pythonAvailable = $false
foreach ($pythonName in @('python.exe', 'python3.exe', 'py.exe')) {
  $pythonCommand = Get-Command $pythonName -ErrorAction SilentlyContinue
  if ($pythonCommand -and $pythonCommand.Source -notlike '*\Microsoft\WindowsApps\*') {
    $pythonVersion = & $pythonCommand.Source --version 2>&1
    if ($LASTEXITCODE -eq 0 -and "$pythonVersion" -match '^Python 3\.') { $pythonAvailable = $true; break }
  }
}
if (-not $pythonAvailable) { $missing += 'Python 3 (python.exe, python3.exe or py.exe)' }
$requiredMissing = @($missing | Where-Object { $Skill -eq 'understand' -or ($Skill -eq 'understand-diff' -and $_ -like 'Git*') })
if (-not $CacheRoot) { $CacheRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CUDIA\addons\understand-anything' }
$cache = [IO.Path]::GetFullPath($CacheRoot)
$fingerprint = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$root = Join-Path $cache ("v$($manifest.version)-" + $manifest.commit.Substring(0, 12) + '-' + $fingerprint.Substring(0, 12))
$plugin = Join-Path $root ("source\Understand-Anything-$($manifest.commit)\understand-anything-plugin")
$ready = Join-Path $root 'ready.json'
if ($CheckOnly) {
  [pscustomobject]@{ AssetsVerified = $true; Initialized = (Test-Path -LiteralPath $ready); CachePath = $root; MissingPrerequisites = @($missing); RequiredMissingPrerequisites = @($requiredMissing); NetworkRequiredOnFirstUse = $true } | ConvertTo-Json -Depth 5
  return
}
if ($RequirePrerequisites -and $requiredMissing.Count -gt 0) { throw ("Optional $Skill prerequisites missing: " + ($requiredMissing -join '; ') + '. Install these only if you want this optional workflow. CUDIA itself does not require them.') }
if (-not (Test-Path -LiteralPath $ready)) {
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  $lockPath = Join-Path $cache 'initialize.lock'
  try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { throw 'Understand Anything initialization is already running. Retry when that invocation completes.' }
  try {
    if (-not (Test-Path -LiteralPath $ready)) {
      # Only this versioned private cache is initialized. No global plugin is discovered or changed.
      New-Item -ItemType Directory -Path $root -Force | Out-Null
      if (-not (Test-Path -LiteralPath (Join-Path $plugin 'package.json'))) { Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'source.zip') -DestinationPath (Join-Path $root 'source') -Force }
      $runtime = Join-Path $root 'runtime'
      New-Item -ItemType Directory -Path $runtime -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node.exe') -Destination (Join-Path $runtime 'node.exe') -Force
      if (-not (Test-Path -LiteralPath (Join-Path $runtime 'package\bin\pnpm.cjs'))) { Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'pnpm.zip') -DestinationPath $runtime -Force }
      $node = Join-Path $runtime 'node.exe'
      $pnpm = Join-Path $runtime 'package\bin\pnpm.cjs'
      $previousCi = $env:CI
      $previousManager = $env:PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS
      try {
        $env:CI = 'true'
        $env:PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS = 'false'
        Write-Host 'Preparing optional Understand Anything dependencies (first invocation; requires network)...'
        & $node $pnpm --dir $plugin install --frozen-lockfile --ignore-scripts --store-dir (Join-Path $root 'pnpm-store') | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Frozen dependency install failed. Check network/registry access and retry; the cache is resumable.' }
        Push-Location (Join-Path $plugin 'packages\core')
        try {
          & $node (Join-Path $plugin 'packages\core\node_modules\typescript\bin\tsc') | Out-Host
          if ($LASTEXITCODE -ne 0) { throw 'Understand Anything core build failed.' }
        } finally { Pop-Location }
      } finally {
        $env:CI = $previousCi
        $env:PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS = $previousManager
      }
      @{ manifestSha256 = $fingerprint; commit = $manifest.commit; version = $manifest.version } | ConvertTo-Json | Set-Content -LiteralPath $ready -Encoding UTF8
    }
  } finally { $lock.Dispose() }
}
$state = Get-Content -Raw -LiteralPath $ready | ConvertFrom-Json
if ($state.manifestSha256 -ne $fingerprint -or -not (Test-Path -LiteralPath (Join-Path $plugin 'packages\core\dist\index.js'))) { throw 'Optional runtime cache is incomplete. Select a new -CacheRoot to rebuild it.' }
[pscustomobject]@{
  Version = $manifest.version
  Commit = $manifest.commit
  PluginRoot = $plugin
  SkillFile = Join-Path $plugin ("skills\$Skill\SKILL.md")
  NodePath = Join-Path $root 'runtime\node.exe'
  PnpmPath = Join-Path $root 'runtime\package\bin\pnpm.cjs'
  RuntimeBin = Join-Path $root 'runtime'
  MissingPrerequisites = @($missing)
  RequiredMissingPrerequisites = @($requiredMissing)
} | ConvertTo-Json -Depth 5
