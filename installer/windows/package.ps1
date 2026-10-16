# Build inputs only: starting the installed engine does not need PowerShell or Git.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EnginePath,
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][long]$Sequence,
    [ValidateSet('stable', 'preview')][string]$Channel = 'preview',
    [ValidateSet('normal', 'baseline')][string]$Variant = 'normal',
    [string]$ClientBuildInfoPath,
    [string]$EngineBuildInfoPath,
    [switch]$RequireEngineProvenance,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if ($Sequence -lt 1 -or $Sequence -gt 9007199254740991) { throw 'Sequence must be a positive JSON safe integer.' }
if ($RequireEngineProvenance -and -not $EngineBuildInfoPath) { throw 'This release requires engine build provenance.' }
if ($Version.Length -gt 128 -or $Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$') {
    throw 'Version must be a semantic version.'
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskDefaults = Join-Path $taskRepo '.opencode'
$taskOutput = [IO.Path]::GetFullPath($OutputPath)
$taskOutputParent = Split-Path -Parent $taskOutput
if (-not (Test-Path -LiteralPath $taskOutputParent -PathType Container)) { throw 'Create the output directory first.' }
if (Test-Path -LiteralPath $taskOutput) { throw 'Output already exists; choose a new artifact path.' }
if ([IO.Path]::GetExtension($taskOutput) -ne '.zip') { throw 'Output must be a ZIP file.' }

function Assert-RegularInput([string]$Path) {
    $taskItem = Get-Item -LiteralPath $Path -Force
    if ($taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Input must be a regular file: $Path"
    }
    if ($taskItem.Length -gt 536870912) { throw 'Input exceeds the package entry size limit.' }
    $taskAncestor = $taskItem.Directory
    while ($taskAncestor) {
        if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Input directory aliases are not allowed.' }
        $taskAncestor = $taskAncestor.Parent
    }
    return $taskItem.FullName
}

function Assert-PackageName([string]$Name) {
    if ($Name -match '[\\:\x00-\x1f]' -or $Name.StartsWith('/') -or $Name.Length -gt 240) { throw 'Invalid package path.' }
    foreach ($taskSegment in $Name.Split('/')) {
        if (-not $taskSegment -or $taskSegment -in @('.', '..') -or $taskSegment -match '[. ]$' -or
            $taskSegment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Invalid Windows package path.' }
    }
}

function Get-PackageHash([string]$Path) {
    $taskHash = [Security.Cryptography.SHA256]::Create()
    $taskInput = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($taskHash.ComputeHash($taskInput))).Replace('-', '').ToLowerInvariant() }
    finally { $taskInput.Dispose(); $taskHash.Dispose() }
}

$taskEngine = Assert-RegularInput $EnginePath
$taskLauncher = Assert-RegularInput $LauncherPath
$taskUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$taskBuilder = [ordered]@{ size = (Get-Item -LiteralPath $PSCommandPath).Length; sha256 = Get-PackageHash $PSCommandPath }
$taskStage = Join-Path $taskOutputParent ('.cudia-package-' + [guid]::NewGuid().ToString('N'))
$taskArchiveTemporary = Join-Path $taskOutputParent ('.cudia-archive-' + [guid]::NewGuid().ToString('N') + '.tmp')
New-Item -ItemType Directory -Path $taskStage | Out-Null
$taskPackageFiles = [ordered]@{}
$taskNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$taskTotal = 0L

function Add-PackageFile([string]$Source, [string]$Name, [byte[]]$Bytes = $null) {
    Assert-PackageName $Name
    if (-not $taskNames.Add($Name)) { throw 'Case-insensitive duplicate package path.' }
    if ($taskNames.Count -gt 4095) { throw 'Too many package entries.' }
    $taskDestination = Join-Path $taskStage ($Name.Replace('/', '\'))
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskDestination)) | Out-Null
    if ($null -ne $Bytes) { [IO.File]::WriteAllBytes($taskDestination, $Bytes) }
    else { [IO.File]::Copy((Assert-RegularInput $Source), $taskDestination, $false) }
    $taskFile = Get-Item -LiteralPath $taskDestination
    if ($taskFile.Length -gt 536870912) { throw 'Package entry too large.' }
    $script:taskTotal += $taskFile.Length
    if ($script:taskTotal -gt 1073741824) { throw 'Expanded package exceeds 1 GiB.' }
    $taskPackageFiles[$Name] = [ordered]@{
        size = $taskFile.Length
        sha256 = Get-PackageHash $taskDestination
    }
}

try {
    Add-PackageFile $taskEngine 'runtime/engine.exe'
    Add-PackageFile $taskLauncher 'launcher.exe'

    # Defaults are data. Executable plugins and local dependency trees are not shipped.
    $taskConfigPath = Assert-RegularInput (Join-Path $taskDefaults 'opencode.json')
    $taskConfig = $taskUtf8.GetString([IO.File]::ReadAllBytes($taskConfigPath)) | ConvertFrom-Json
    # Developer model choices must not pin a fresh installation to an unconfigured account.
    $taskConfig.PSObject.Properties.Remove('model')
    $taskConfig.PSObject.Properties.Remove('small_model')
    foreach ($taskPluginKey in @('plugin', 'plugins')) {
        if ($taskConfig.PSObject.Properties[$taskPluginKey]) { throw 'Packaged defaults cannot declare plugins.' }
    }
    if ($taskConfig.PSObject.Properties['experimental'] -and $taskConfig.experimental.PSObject.Properties['policies']) {
        throw 'Packaged defaults cannot declare experimental policies.'
    }
    # The optional bridge resolves its shipped source from immutable defaults.
    if ($taskConfig.mcp.PSObject.Properties['claude-bridge']) {
        $taskConfig.mcp.'claude-bridge'.command = @(
            'node', '--input-type=module', '--eval',
            "import { pathToFileURL } from 'node:url'; import { resolve } from 'node:path'; await import(pathToFileURL(resolve(process.env.CUDIA_DISTRIBUTION_DIR || process.env.OPENCODE_CONFIG_DIR || '.opencode', 'mcp/claude-bridge/server.mjs')).href)"
        )
    }
    Add-PackageFile '' 'defaults/opencode.json' ($taskUtf8.GetBytes(($taskConfig | ConvertTo-Json -Depth 64)))
    $taskTuiPath = Assert-RegularInput (Join-Path $taskDefaults 'tui.json')
    $taskTui = $taskUtf8.GetString([IO.File]::ReadAllBytes($taskTuiPath)) | ConvertFrom-Json
    $taskTui.PSObject.Properties.Remove('plugin')
    $taskTui.PSObject.Properties.Remove('plugins')
    Add-PackageFile '' 'defaults/tui.json' ($taskUtf8.GetBytes(($taskTui | ConvertTo-Json -Depth 64)))

    foreach ($taskTree in @('agent', 'command', 'skills', 'glossary')) {
        $taskSourceRoot = Join-Path $taskDefaults $taskTree
        $taskPrefix = [IO.Path]::GetFullPath($taskSourceRoot).TrimEnd('\') + '\'
        foreach ($taskFile in (Get-ChildItem -LiteralPath $taskSourceRoot -File -Recurse -Force | Sort-Object FullName)) {
            if ($taskFile.Extension -ne '.md') { continue }
            if (-not $taskFile.FullName.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid asset location.' }
            Add-PackageFile $taskFile.FullName ('defaults/' + $taskTree + '/' + $taskFile.FullName.Substring($taskPrefix.Length).Replace('\', '/'))
        }
    }
    # Packaged prompts can specialize commands for ordinary projects while the
    # development prompts remain tailored to this checkout.
    $taskCommandOverrides = Join-Path $PSScriptRoot 'defaults\command'
    if (Test-Path -LiteralPath $taskCommandOverrides -PathType Container) {
        $taskOverridePrefix = [IO.Path]::GetFullPath($taskCommandOverrides).TrimEnd('\') + '\'
        foreach ($taskOverride in (Get-ChildItem -LiteralPath $taskCommandOverrides -File -Recurse -Force | Sort-Object FullName)) {
            if ($taskOverride.Extension -ne '.md' -or -not $taskOverride.FullName.StartsWith($taskOverridePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Invalid packaged command override.'
            }
            $taskName = 'defaults/command/' + $taskOverride.FullName.Substring($taskOverridePrefix.Length).Replace('\', '/')
            if (-not $taskNames.Contains($taskName)) { throw "Command override has no source command: $taskName" }
            $taskExistingPath = Join-Path $taskStage ($taskName.Replace('/', '\'))
            $taskTotal -= (Get-Item -LiteralPath $taskExistingPath).Length
            Remove-Item -LiteralPath $taskExistingPath -Force
            [void]$taskNames.Remove($taskName)
            $taskPackageFiles.Remove($taskName)
            Add-PackageFile $taskOverride.FullName $taskName
        }
    }
    Add-PackageFile (Join-Path $taskDefaults 'themes\mytheme.json') 'defaults/themes/mytheme.json'
    foreach ($taskBridgeFile in @('server.mjs', 'package.json', 'README.md')) {
        Add-PackageFile (Join-Path $taskDefaults ('mcp\claude-bridge\' + $taskBridgeFile)) ('defaults/mcp/claude-bridge/' + $taskBridgeFile)
    }
    $taskClientBuild = $null
    if ($ClientBuildInfoPath) {
        $taskClientInfo = Assert-RegularInput $ClientBuildInfoPath
        if ((Get-Item -LiteralPath $taskClientInfo).Length -gt 1048576) { throw 'Client build provenance exceeds 1 MiB.' }
        $taskClientBytes = [IO.File]::ReadAllBytes($taskClientInfo)
        $taskClientText = $taskUtf8.GetString($taskClientBytes)
        if ($taskClientText -match 'PRIVATE KEY') { throw 'Client build provenance must contain only public metadata.' }
        $taskClient = $taskClientText | ConvertFrom-Json
        if ($taskClient.schema -ne 1 -or $taskClient.product -cne 'cudia' -or $taskClient.kind -cne 'windows-client-build' -or
            $taskClient.outputs.'launcher.exe'.sha256 -cne $taskPackageFiles['launcher.exe'].sha256 -or
            $taskClient.outputs.'launcher.exe'.size -ne $taskPackageFiles['launcher.exe'].size) {
            throw 'Client build provenance does not match the packaged launcher.'
        }
        Add-PackageFile '' 'defaults/cudia-client-build.json' $taskClientBytes
        $taskClientBuild = [ordered]@{
            path = 'defaults/cudia-client-build.json'
            size = $taskPackageFiles['defaults/cudia-client-build.json'].size
            sha256 = $taskPackageFiles['defaults/cudia-client-build.json'].sha256
        }
    }
    $taskEngineBuild = $null
    if ($EngineBuildInfoPath) {
        $taskEngineInfo = Assert-RegularInput $EngineBuildInfoPath
        if ((Get-Item -LiteralPath $taskEngineInfo).Length -gt 1048576) { throw 'Engine build receipt exceeds 1 MiB.' }
        $taskEngineBytes = [IO.File]::ReadAllBytes($taskEngineInfo)
        $taskEngineText = $taskUtf8.GetString($taskEngineBytes)
        if ($taskEngineText -match 'PRIVATE KEY') { throw 'Engine build provenance must contain only public metadata.' }
        $taskEngineRecord = $taskEngineText | ConvertFrom-Json
        if ($taskEngineRecord.schema -ne 1 -or $taskEngineRecord.product -cne 'cudia' -or $taskEngineRecord.kind -cne 'engine-build' -or
            $taskEngineRecord.identity.platform -cne 'windows' -or $taskEngineRecord.identity.arch -cne 'x64' -or $taskEngineRecord.identity.variant -cne $Variant -or
            $taskEngineRecord.identity.version -isnot [string] -or $taskEngineRecord.identity.version.Length -lt 1 -or $taskEngineRecord.identity.version.Length -gt 128 -or
            $taskEngineRecord.output.sha256 -cne $taskPackageFiles['runtime/engine.exe'].sha256 -or
            $taskEngineRecord.output.size -ne $taskPackageFiles['runtime/engine.exe'].size -or $taskEngineRecord.build.discoveryPass -ne $true -or
            $taskEngineRecord.build.recipe.compile.target -cne $(if ($Variant -eq 'baseline') { 'bun-windows-x64-baseline' } else { 'bun-windows-x64' }) -or
            $taskEngineRecord.build.repositoryHead -cnotmatch '^[a-f0-9]{40}$' -or $taskEngineRecord.inventory.path -cne 'engine-inputs.json') {
            throw 'Engine build provenance does not match the packaged engine or variant.'
        }
        $taskEngineInputs = Assert-RegularInput (Join-Path (Split-Path -Parent $taskEngineInfo) 'engine-inputs.json')
        if ((Get-Item -LiteralPath $taskEngineInputs).Length -gt 4194304) { throw 'Engine input inventory exceeds 4 MiB.' }
        $taskEngineInputBytes = [IO.File]::ReadAllBytes($taskEngineInputs)
        if ($taskEngineRecord.inventory.size -ne $taskEngineInputBytes.Length -or $taskEngineRecord.inventory.sha256 -cne (Get-PackageHash $taskEngineInputs)) {
            throw 'Engine input inventory digest differs from its build receipt.'
        }
        $taskEngineInputRecord = $taskUtf8.GetString($taskEngineInputBytes) | ConvertFrom-Json
        if ($taskEngineInputRecord.schema -ne 1 -or $taskEngineInputRecord.repository.head -cne $taskEngineRecord.build.repositoryHead -or
            $null -eq $taskEngineInputRecord.repository.files -or $null -eq $taskEngineInputRecord.bundler) { throw 'Engine input inventory identity differs.' }
        Add-PackageFile '' 'defaults/cudia-engine-build.json' $taskEngineBytes
        Add-PackageFile '' 'defaults/engine-inputs.json' $taskEngineInputBytes
        $taskEngineBuild = [ordered]@{ path = 'defaults/cudia-engine-build.json'; size = $taskPackageFiles['defaults/cudia-engine-build.json'].size; sha256 = $taskPackageFiles['defaults/cudia-engine-build.json'].sha256 }
    }
    # This inventory describes the actual frozen package inputs. It does not
    # infer the engine's source revision from the packaging checkout.
    $taskDefaultFiles = [ordered]@{}
    foreach ($taskName in $taskPackageFiles.Keys) {
        if ($taskName.StartsWith('defaults/')) { $taskDefaultFiles[$taskName] = $taskPackageFiles[$taskName] }
    }
    if ((Get-PackageHash $PSCommandPath) -cne $taskBuilder.sha256) { throw 'Package build script changed during packaging.' }
    $taskProvenance = [ordered]@{
        schema = 1; product = 'cudia'; kind = 'windows-package-build'
        identity = [ordered]@{ version = $Version; sequence = $Sequence; channel = $Channel; variant = $Variant; bootstrapABI = 1 }
        build = [ordered]@{ builder = $taskBuilder; powershellVersion = $PSVersionTable.PSVersion.ToString(); powershellEdition = $PSVersionTable.PSEdition }
        inputs = [ordered]@{
            engine = $taskPackageFiles['runtime/engine.exe']; engineSource = if ($null -ne $taskEngineBuild) { 'observed-build' } else { 'not-recorded' }; engineBuild = $taskEngineBuild
            launcher = $taskPackageFiles['launcher.exe']; clientBuild = $taskClientBuild
        }
        defaults = $taskDefaultFiles
    }
    $taskProvenanceBytes = $taskUtf8.GetBytes(($taskProvenance | ConvertTo-Json -Depth 64))
    if ($taskProvenanceBytes.Length -gt 1048576) { throw 'Package provenance exceeds 1 MiB.' }
    Add-PackageFile '' 'defaults/cudia-package-build.json' $taskProvenanceBytes
    $taskDescriptor = [ordered]@{
        schema = 1; product = 'cudia'; version = $Version; channel = $Channel; sequence = $Sequence
        platform = 'windows'; arch = 'x64'; variant = $Variant; bootstrapABI = 1; files = $taskPackageFiles
    }
    $taskDescriptorBytes = $taskUtf8.GetBytes(($taskDescriptor | ConvertTo-Json -Depth 64))
    if ($taskDescriptorBytes.Length -gt 1048576) { throw 'Package descriptor exceeds 1 MiB.' }
    [IO.File]::WriteAllBytes((Join-Path $taskStage 'package.json'), $taskDescriptorBytes)
    $taskStream = New-Object IO.FileStream($taskArchiveTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $taskZip = New-Object IO.Compression.ZipArchive($taskStream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($taskName in (@('package.json') + @($taskPackageFiles.Keys))) {
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip, (Join-Path $taskStage $taskName.Replace('/', '\')), $taskName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $taskZip.Dispose() }
        $taskStream.Flush($true)
    } finally { $taskStream.Dispose() }
    # Move without overwrite, after the complete archive is closed and flushed.
    [IO.File]::Move($taskArchiveTemporary, $taskOutput)
    [ordered]@{
        path = $taskOutput; version = $Version; sequence = $Sequence; channel = $Channel; variant = $Variant
        size = (Get-Item -LiteralPath $taskOutput).Length
        sha256 = Get-PackageHash $taskOutput
        files = $taskPackageFiles.Count
        provenance = $taskPackageFiles['defaults/cudia-package-build.json']
    } | ConvertTo-Json
} finally {
    # Only remove the unique staging directory created by this invocation.
    $taskResolvedStage = [IO.Path]::GetFullPath($taskStage)
    $taskParentPrefix = [IO.Path]::GetFullPath($taskOutputParent).TrimEnd('\') + '\'
    if ($taskResolvedStage.StartsWith($taskParentPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $taskResolvedStage) -match '^\.cudia-package-[a-f0-9]{32}$' -and
        (Test-Path -LiteralPath $taskResolvedStage -PathType Container)) {
        $taskReparse = Get-ChildItem -LiteralPath $taskResolvedStage -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
        if (-not $taskReparse -and -not ((Get-Item -LiteralPath $taskResolvedStage).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $taskResolvedStage -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $taskArchiveTemporary -PathType Leaf) { Remove-Item -LiteralPath $taskArchiveTemporary -Force }
}
