#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$DownloadsPath
)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw "OutputPath must be a new directory: $output" }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Packaging requires tar.exe to unpack the verified pnpm distribution.' }
$inputs = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') | ConvertFrom-Json
$downloads = if ($DownloadsPath) { [IO.Path]::GetFullPath($DownloadsPath) } else { Join-Path $env:TEMP ('cudia-ua-download-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($inputAsset in $inputs.inputs) {
  $path = Join-Path $downloads $inputAsset.file
  if (-not (Test-Path -LiteralPath $path)) { Invoke-WebRequest -UseBasicParsing -Uri $inputAsset.url -OutFile $path }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $inputAsset.sha256) { throw "Frozen input hash mismatch: $($inputAsset.file)" }
}
$assets = Join-Path $output 'addons\understand-anything'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
foreach ($file in @('source.zip', 'node.exe', 'NODE-LICENSE.txt')) { Copy-Item -LiteralPath (Join-Path $downloads $file) -Destination $assets }
$unpack = Join-Path $output ('pnpm-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $unpack | Out-Null
& tar.exe -xzf (Join-Path $downloads 'pnpm.tgz') -C $unpack
if ($LASTEXITCODE -ne 0) { throw 'Could not unpack verified pnpm archive.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $unpack 'package'), (Join-Path $assets 'pnpm.zip'), [IO.Compression.CompressionLevel]::Optimal, $true)
Copy-Item -LiteralPath (Join-Path $unpack 'package\LICENSE') -Destination (Join-Path $assets 'PNPM-LICENSE.txt')
# This directory was created above under the already-resolved new output root.
if (-not $unpack.StartsWith($output + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging path.' }
Remove-Item -LiteralPath $unpack -Recurse -Force
foreach ($file in @('bootstrap.ps1', 'README.md', 'inputs.json')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $assets }
$manifest = [ordered]@{
  schemaVersion = 1
  version = $inputs.version
  commit = $inputs.commit
  nodeVersion = $inputs.nodeVersion
  pnpmVersion = $inputs.pnpmVersion
  architecture = 'win-x64'
  files = @()
}
foreach ($file in Get-ChildItem -LiteralPath $assets -File | Sort-Object Name) {
  $manifest.files += [ordered]@{ file = $file.Name; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = $file.Length }
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $assets 'manifest.json') -Encoding UTF8
[pscustomobject]@{ OptionalAssetsPath = $output; AddonPath = $assets; Files = $manifest.files.Count + 1; Bytes = (Get-ChildItem -LiteralPath $assets -File | Measure-Object -Property Length -Sum).Sum } | ConvertTo-Json
