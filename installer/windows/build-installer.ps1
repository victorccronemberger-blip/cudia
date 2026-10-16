[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BootstrapPath,
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [ValidateSet('stable', 'preview')][string]$Channel = 'preview',
    [ValidateSet('normal', 'baseline')][string]$Variant = 'normal',
    [string]$OutputDirectory,
    [string]$CompilerPath,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$taskUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = $taskUtf8

function Assert-PathChain([string]$Path) {
    if ($Path -match '[\x00-\x1f"<>|?*]' -or $Path -match '^[\\]{2}' -or $Path -match '^.*:.*:') {
        throw 'Use a local path without alternate streams, wildcards or control characters.'
    }
    $taskFull = [IO.Path]::GetFullPath($Path)
    $taskCurrent = $taskFull
    while ($taskCurrent) {
        if (Test-Path -LiteralPath $taskCurrent) {
            $taskItem = Get-Item -LiteralPath $taskCurrent -Force
            if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Path aliases and reparse points are not accepted.' }
        }
        $taskParent = [IO.Path]::GetDirectoryName($taskCurrent)
        if ($taskParent -eq $taskCurrent) { break }
        $taskCurrent = $taskParent
    }
    return $taskFull
}

function Assert-RegularFile([string]$Path, [long]$Limit) {
    $taskFull = Assert-PathChain $Path
    $taskItem = Get-Item -LiteralPath $taskFull -Force
    if ($taskItem.PSIsContainer -or $taskItem.Length -lt 1 -or $taskItem.Length -gt $Limit) {
        throw 'Input must be a nonempty regular file within its size limit.'
    }
    return $taskFull
}

function Get-BuildHash([string]$Path) {
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    $taskStream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($taskHasher.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskHasher.Dispose() }
}

function Invoke-BuildProgram([string]$Program, [string[]]$Arguments) {
    $taskResult = & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Build validation or compiler failed: ' + [IO.Path]::GetFileName($Program) + ' (' + (($Arguments | Select-Object -First 2) -join ' ') + ')') }
    return ($taskResult -join "`n")
}

function Remove-PrivateStage([string]$Path) {
    $taskFull = Assert-PathChain $Path
    $taskTemp = (Assert-PathChain ([IO.Path]::GetTempPath())).TrimEnd('\') + '\'
    if (-not $taskFull.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $taskFull) -notmatch '^cudia-installer-build-[a-f0-9]{32}$') { throw 'Refusing cleanup outside the owned temporary build directory.' }
    if (-not (Test-Path -LiteralPath $taskFull)) { return }
    # Walk one level at a time: do not traverse a link while checking for links.
    $taskQueue = New-Object 'System.Collections.Generic.Queue[string]'
    $taskQueue.Enqueue($taskFull)
    while ($taskQueue.Count -gt 0) {
        foreach ($taskItem in (Get-ChildItem -LiteralPath $taskQueue.Dequeue() -Force)) {
            if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup of a build directory containing an alias.' }
            if ($taskItem.PSIsContainer) { $taskQueue.Enqueue($taskItem.FullName) }
        }
    }
    Remove-Item -LiteralPath $taskFull -Recurse -Force
}

# Never acquire a compiler. Fail before reading inputs or making build artifacts.
$taskCompiler = $null
if ($CompilerPath) {
    $taskCompilerPath = Assert-PathChain $CompilerPath
    if (-not (Test-Path -LiteralPath $taskCompilerPath -PathType Leaf)) {
        throw 'CompilerPath must name an existing local Inno Setup ISCC.exe. No compiler is downloaded; use -PrepareOnly for developer build inputs without an executable.'
    }
    $taskCompiler = Assert-RegularFile $taskCompilerPath 67108864
}
if (-not $PrepareOnly -and -not $taskCompiler) {
    $taskCommand = Get-Command 'ISCC.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskCommand) { $taskCompiler = Assert-RegularFile $taskCommand.Source 67108864 }
    if (-not $taskCompiler) { throw 'An existing local Inno Setup ISCC.exe is required. Pass -CompilerPath, or use -PrepareOnly to create developer build inputs without an installer executable.' }
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot ('dist\setup-' + [guid]::NewGuid().ToString('N')) }
$taskOutput = Assert-PathChain $OutputDirectory
if (Test-Path -LiteralPath $taskOutput) { throw 'Output already exists; choose a fresh output directory.' }
$taskInputs = [ordered]@{
    'cudia.exe' = Assert-RegularFile $BootstrapPath 67108864
    'launcher.exe' = Assert-RegularFile $LauncherPath 67108864
    'release.json' = Assert-RegularFile $ManifestPath 65536
    'bundle.zip' = Assert-RegularFile $ArchivePath 2147483648
    'wizard.iss' = Assert-RegularFile (Join-Path $PSScriptRoot 'wizard.iss') 1048576
}
$taskBuilder = [ordered]@{ size = (Get-Item -LiteralPath $PSCommandPath).Length; sha256 = Get-BuildHash $PSCommandPath }
$taskStage = Join-Path (Assert-PathChain ([IO.Path]::GetTempPath())) ('cudia-installer-build-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskStage) | Out-Null
$taskTicket = $null
$taskHelper = Join-Path $taskStage 'launcher.exe'
$taskValidation = Join-Path $taskStage 'validation'
try {
    # All validation and compilation uses these exact frozen copies.
    foreach ($taskName in $taskInputs.Keys) {
        [IO.File]::Copy($taskInputs[$taskName], (Join-Path $taskStage $taskName), $false)
        Assert-RegularFile (Join-Path $taskStage $taskName) $(if ($taskName -eq 'bundle.zip') { 2147483648 } elseif ($taskName -eq 'release.json') { 65536 } elseif ($taskName -eq 'wizard.iss') { 1048576 } else { 67108864 }) | Out-Null
    }
    $taskTrust = (Invoke-BuildProgram $taskHelper @('trust-info')) | ConvertFrom-Json
    if ($taskTrust.schema -ne 1 -or $taskTrust.bootstrapABI -ne 1 -or ($taskTrust.trustedKeys -isnot [int] -and $taskTrust.trustedKeys -isnot [long]) -or
        $taskTrust.trustedKeys -lt 1 -or $taskTrust.trustSha256 -isnot [string] -or $taskTrust.trustSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Installer builds require a launcher with at least one compiled public release key.'
    }
    $taskCapabilities = (Invoke-BuildProgram $taskHelper @('installer', 'capabilities')) | ConvertFrom-Json
    if ($taskCapabilities.schema -ne 1 -or $taskCapabilities.physicalContext -ne 1) {
        throw 'This wizard requires a native helper with physical filesystem context verification.'
    }
    [IO.Directory]::CreateDirectory($taskValidation) | Out-Null
    $taskPrepared = (Invoke-BuildProgram $taskHelper @('installer', 'prepare', '--root', $taskValidation,
        '--manifest', (Join-Path $taskStage 'release.json'), '--archive', (Join-Path $taskStage 'bundle.zip'),
        '--bootstrap', (Join-Path $taskStage 'cudia.exe'), '--channel', $Channel, '--variant', $Variant,
        '--ticket-output', (Join-Path $taskStage 'ticket.txt'))) | ConvertFrom-Json
    if ($taskPrepared.ticket -isnot [string] -or $taskPrepared.ticket -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid preparation ticket.' }
    $taskTicket = $taskPrepared.ticket
    if ($taskPrepared.version -isnot [string] -or $taskPrepared.version.Length -gt 128 -or
        $taskPrepared.version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$' -or
        $taskPrepared.channel -cne $Channel -or $taskPrepared.variant -cne $Variant -or
        $taskPrepared.releaseId -isnot [string] -or $taskPrepared.releaseId -cnotmatch '^seq-[1-9][0-9]{0,15}-[a-f0-9]{64}$') { throw 'Invalid prepared release identity.' }

    # The native helper already authenticated the archive and every descriptor byte.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskZip = [IO.Compression.ZipFile]::OpenRead((Join-Path $taskStage 'bundle.zip'))
    $taskPackageProvenance = $null
    try {
        $taskEntry = $taskZip.GetEntry('package.json')
        if ($null -eq $taskEntry -or $taskEntry.Length -gt 1048576) { throw 'Missing or oversized verified descriptor.' }
        $taskReader = New-Object IO.StreamReader($taskEntry.Open(), $taskUtf8)
        try { $taskDescriptor = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
        $taskProvenanceEntry = $taskZip.GetEntry('defaults/cudia-package-build.json')
        if ($null -ne $taskProvenanceEntry) {
            if ($taskProvenanceEntry.Length -gt 1048576) { throw 'Oversized package provenance.' }
            $taskReader = New-Object IO.StreamReader($taskProvenanceEntry.Open(), $taskUtf8)
            try { $taskPackageProvenance = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
            if ($taskPackageProvenance.schema -ne 1 -or $taskPackageProvenance.product -cne 'cudia' -or
                $taskPackageProvenance.kind -cne 'windows-package-build' -or
                $taskPackageProvenance.identity.version -cne $taskDescriptor.version -or
                $taskPackageProvenance.identity.sequence -ne $taskDescriptor.sequence -or
                $taskPackageProvenance.identity.channel -cne $Channel -or $taskPackageProvenance.identity.variant -cne $Variant -or
                $taskPackageProvenance.identity.bootstrapABI -ne $taskDescriptor.bootstrapABI -or
                $taskPackageProvenance.inputs.engine.sha256 -cne $taskDescriptor.files.'runtime/engine.exe'.sha256 -or
                $taskPackageProvenance.inputs.engine.size -ne $taskDescriptor.files.'runtime/engine.exe'.size -or
                $taskPackageProvenance.inputs.launcher.sha256 -cne $taskDescriptor.files.'launcher.exe'.sha256 -or
                $taskPackageProvenance.inputs.launcher.size -ne $taskDescriptor.files.'launcher.exe'.size) {
                throw 'Authenticated package provenance and descriptor disagree.'
            }
            $taskDefaultNames = @($taskDescriptor.files.PSObject.Properties.Name | Where-Object { $_.StartsWith('defaults/') -and $_ -cne 'defaults/cudia-package-build.json' })
            if (@($taskPackageProvenance.defaults.PSObject.Properties).Count -ne $taskDefaultNames.Count) { throw 'Package provenance default inventory differs.' }
            foreach ($taskDefault in $taskPackageProvenance.defaults.PSObject.Properties) {
                if ($taskDefaultNames -cnotcontains $taskDefault.Name -or
                    $taskDefault.Value.sha256 -cne $taskDescriptor.files.($taskDefault.Name).sha256 -or
                    $taskDefault.Value.size -ne $taskDescriptor.files.($taskDefault.Name).size) { throw 'Package provenance default inventory differs.' }
            }
            if ($taskPackageProvenance.inputs.engineSource -cnotin @('not-recorded', 'observed-build')) { throw 'Unsupported engine provenance status.' }
            $taskEngineReference = if ($taskPackageProvenance.inputs.PSObject.Properties['engineBuild']) { $taskPackageProvenance.inputs.engineBuild } else { $null }
            if ($taskPackageProvenance.inputs.engineSource -ceq 'observed-build') {
                $taskEngineEntry = $taskZip.GetEntry('defaults/cudia-engine-build.json')
                if ($null -eq $taskEngineReference -or $taskEngineReference.path -cne 'defaults/cudia-engine-build.json' -or
                    $null -eq $taskEngineEntry -or $taskEngineEntry.Length -gt 1048576 -or
                    $taskEngineReference.size -ne $taskDescriptor.files.'defaults/cudia-engine-build.json'.size -or
                    $taskEngineReference.sha256 -cne $taskDescriptor.files.'defaults/cudia-engine-build.json'.sha256) { throw 'Package engine provenance reference differs.' }
                $taskReader = New-Object IO.StreamReader($taskEngineEntry.Open(), $taskUtf8)
                try { $taskEngineProvenance = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
                if ($taskEngineProvenance.schema -ne 1 -or $taskEngineProvenance.product -cne 'cudia' -or $taskEngineProvenance.kind -cne 'engine-build' -or
                    $taskEngineProvenance.identity.platform -cne 'windows' -or $taskEngineProvenance.identity.arch -cne 'x64' -or $taskEngineProvenance.identity.variant -cne $Variant -or
                    $taskEngineProvenance.output.sha256 -cne $taskDescriptor.files.'runtime/engine.exe'.sha256 -or
                    $taskEngineProvenance.output.size -ne $taskDescriptor.files.'runtime/engine.exe'.size -or
                    $taskEngineProvenance.build.recipe.compile.target -cne $(if ($Variant -eq 'baseline') { 'bun-windows-x64-baseline' } else { 'bun-windows-x64' }) -or
                    $taskEngineProvenance.build.discoveryPass -ne $true -or $taskEngineProvenance.build.repositoryHead -cnotmatch '^[a-f0-9]{40}$' -or
                    $taskEngineProvenance.inventory.path -cne 'engine-inputs.json') { throw 'Authenticated engine provenance does not match the installer inputs.' }
                $taskEngineInputs = $taskZip.GetEntry('defaults/engine-inputs.json')
                if ($null -eq $taskEngineInputs -or $taskEngineInputs.Length -gt 4194304 -or
                    $taskEngineProvenance.inventory.size -ne $taskDescriptor.files.'defaults/engine-inputs.json'.size -or
                    $taskEngineProvenance.inventory.sha256 -cne $taskDescriptor.files.'defaults/engine-inputs.json'.sha256) { throw 'Authenticated engine input inventory differs.' }
                $taskReader = New-Object IO.StreamReader($taskEngineInputs.Open(), $taskUtf8)
                try { $taskEngineInventory = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
                if ($taskEngineInventory.schema -ne 1 -or $taskEngineInventory.repository.head -cne $taskEngineProvenance.build.repositoryHead -or
                    $null -eq $taskEngineInventory.repository.files -or $null -eq $taskEngineInventory.bundler) { throw 'Authenticated engine input inventory identity differs.' }
            } elseif ($null -ne $taskEngineReference) { throw 'Package claims an engine receipt without observed build provenance.' }
            if ($null -ne $taskPackageProvenance.inputs.clientBuild) {
                $taskClientEntry = $taskZip.GetEntry('defaults/cudia-client-build.json')
                $taskClientReference = $taskPackageProvenance.inputs.clientBuild
                if ($taskClientReference.path -cne 'defaults/cudia-client-build.json' -or $null -eq $taskClientEntry -or
                    $taskClientEntry.Length -gt 1048576 -or
                    $taskClientReference.sha256 -cne $taskDescriptor.files.'defaults/cudia-client-build.json'.sha256 -or
                    $taskClientReference.size -ne $taskDescriptor.files.'defaults/cudia-client-build.json'.size) { throw 'Package client provenance reference differs.' }
                $taskReader = New-Object IO.StreamReader($taskClientEntry.Open(), $taskUtf8)
                try { $taskClientProvenance = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
                if ($taskClientProvenance.schema -ne 1 -or $taskClientProvenance.product -cne 'cudia' -or $taskClientProvenance.kind -cne 'windows-client-build' -or
                    $taskClientProvenance.outputs.'launcher.exe'.sha256 -cne (Get-BuildHash $taskHelper) -or
                    $taskClientProvenance.outputs.'launcher.exe'.size -ne (Get-Item -LiteralPath $taskHelper).Length -or
                    $taskClientProvenance.outputs.'cudia.exe'.sha256 -cne (Get-BuildHash (Join-Path $taskStage 'cudia.exe')) -or
                    $taskClientProvenance.outputs.'cudia.exe'.size -ne (Get-Item -LiteralPath (Join-Path $taskStage 'cudia.exe')).Length -or
                    $taskClientProvenance.trust.trustSha256 -cne $taskTrust.trustSha256) { throw 'Authenticated client provenance does not match the installer inputs.' }
            }
        }
    } finally { $taskZip.Dispose() }
    $taskHelperHash = Get-BuildHash $taskHelper
    $taskArchiveHash = Get-BuildHash (Join-Path $taskStage 'bundle.zip')
    if ($taskDescriptor.files.'launcher.exe'.sha256 -cne $taskHelperHash -or
        $taskDescriptor.files.'launcher.exe'.size -ne (Get-Item -LiteralPath $taskHelper).Length) {
        throw 'The build helper must exactly match the launcher authenticated in the bundled release.'
    }
    if ($taskDescriptor.sequence -isnot [ValueType] -or $taskDescriptor.sequence -lt 1 -or $taskDescriptor.sequence -gt 9007199254740991 -or
        [decimal]$taskDescriptor.sequence -ne [math]::Truncate([decimal]$taskDescriptor.sequence) -or
        $taskPrepared.releaseId -cne ('seq-' + $taskDescriptor.sequence + '-' + $taskArchiveHash) -or
        $taskDescriptor.version -cne $taskPrepared.version -or $taskDescriptor.channel -cne $Channel -or $taskDescriptor.variant -cne $Variant) {
        throw 'Verified descriptor and preparation identities disagree.'
    }

    # Prove the bootstrap handshake using only this private installation. No engine is run.
    [IO.Directory]::CreateDirectory((Join-Path $taskValidation 'bin')) | Out-Null
    $taskBootstrap = Join-Path $taskValidation 'bin\cudia.exe'
    [IO.File]::Copy((Join-Path $taskStage 'cudia.exe'), $taskBootstrap, $false)
    Invoke-BuildProgram $taskHelper @('installer', 'commit', '--root', $taskValidation, '--ticket', $taskTicket) | Out-Null
    $taskInfo = (Invoke-BuildProgram $taskBootstrap @('installation', 'info')) | ConvertFrom-Json
    if ($taskInfo.state.selectedReleaseId -cne $taskPrepared.releaseId -or $taskInfo.trustSha256 -cne $taskTrust.trustSha256 -or
        $taskInfo.trustedKeys -ne $taskTrust.trustedKeys) { throw 'Bootstrap installation handshake does not match the verified release.' }
    Invoke-BuildProgram $taskHelper @('installer', 'abort', '--root', $taskValidation, '--ticket', $taskTicket) | Out-Null
    $taskTicket = $null

    $taskOutputName = 'cudia-' + $taskPrepared.version + '-windows-x64-' + $Variant + '-setup'
    $taskWindowsVersion = [Version]::Parse($taskPrepared.version.Split('+')[0].Split('-')[0])
    if ($taskWindowsVersion.Major -gt 65535 -or $taskWindowsVersion.Minor -gt 65535 -or $taskWindowsVersion.Build -gt 65535) {
        throw 'The release version exceeds Windows executable version limits.'
    }
    $taskDefines = [ordered]@{
        CudiaVersion = $taskPrepared.version; CudiaChannel = $Channel; CudiaVariant = $Variant
        CudiaFileVersion = ('{0}.{1}.{2}.0' -f $taskWindowsVersion.Major, $taskWindowsVersion.Minor, $taskWindowsVersion.Build)
        CudiaSequence = [long]$taskDescriptor.sequence
        CudiaBootstrapSHA256 = Get-BuildHash (Join-Path $taskStage 'cudia.exe')
        CudiaHelperSHA256 = $taskHelperHash; CudiaArchiveSHA256 = $taskArchiveHash
        CudiaArchiveSize = (Get-Item -LiteralPath (Join-Path $taskStage 'bundle.zip')).Length
        CudiaReleaseID = $taskPrepared.releaseId; CudiaOutputName = $taskOutputName
        CudiaManifestSHA256 = Get-BuildHash (Join-Path $taskStage 'release.json'); CudiaTrustDigest = $taskTrust.trustSha256
    }
    $taskLines = @('; Generated verified build inputs. Contains only public release material.')
    foreach ($taskName in $taskDefines.Keys) {
        if ($taskName -in @('CudiaSequence', 'CudiaArchiveSize')) { $taskLines += '#define ' + $taskName + ' ' + $taskDefines[$taskName] }
        else { $taskLines += '#define ' + $taskName + ' "' + $taskDefines[$taskName] + '"' }
    }
    [IO.File]::WriteAllLines((Join-Path $taskStage 'bundle.iss'), $taskLines, $taskUtf8)
    Assert-PathChain (Split-Path -Parent $taskOutput) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $taskOutput)) | Out-Null
    # New-Item refuses existing destinations, including a concurrent build's output.
    New-Item -ItemType Directory -Path $taskOutput -ErrorAction Stop | Out-Null
    foreach ($taskName in (@($taskInputs.Keys) + @('bundle.iss'))) {
        [IO.File]::Copy((Join-Path $taskStage $taskName), (Join-Path $taskOutput $taskName), $false)
    }
    $taskHashes = [ordered]@{}
    foreach ($taskName in (@($taskInputs.Keys) + @('bundle.iss'))) { $taskHashes[$taskName] = Get-BuildHash (Join-Path $taskOutput $taskName) }
    $taskBuild = [ordered]@{
        schema = 1; completed = $false; compiled = $false; developerArtifact = $true; validatedForPublication = $false; outputDirectory = $taskOutput
        version = $taskPrepared.version; channel = $Channel; variant = $Variant; sequence = [long]$taskDescriptor.sequence
        releaseId = $taskPrepared.releaseId; trust = $taskTrust; installerCapabilities = $taskCapabilities; sources = $taskHashes
        compiler = $null; installer = $null; packaging = 'inno-setup'
        provenance = [ordered]@{
            builder = $taskBuilder; powershellVersion = $PSVersionTable.PSVersion.ToString(); powershellEdition = $PSVersionTable.PSEdition
            package = if ($null -ne $taskPackageProvenance) { $taskDescriptor.files.'defaults/cudia-package-build.json' } else { $null }
            engine = $taskDescriptor.files.'runtime/engine.exe'
            engineSource = if ($null -ne $taskPackageProvenance) { $taskPackageProvenance.inputs.engineSource } else { 'not-recorded' }
            engineBuild = if ($null -ne $taskPackageProvenance -and $taskPackageProvenance.inputs.PSObject.Properties['engineBuild']) { $taskPackageProvenance.inputs.engineBuild } else { $null }
            release = $null
        }
    }
    $taskInfoPath = Join-Path $taskOutput 'build-info.json'
    $taskEnvelope = $taskUtf8.GetString([IO.File]::ReadAllBytes((Join-Path $taskStage 'release.json'))) | ConvertFrom-Json
    $taskReleasePayload = $taskUtf8.GetString([Convert]::FromBase64String($taskEnvelope.payload)) | ConvertFrom-Json
    $taskBuild.provenance.release = [ordered]@{ keyId = $taskEnvelope.keyId; issuedAt = $taskReleasePayload.issuedAt; expiresAt = $taskReleasePayload.expiresAt }
    [IO.File]::WriteAllText($taskInfoPath, ($taskBuild | ConvertTo-Json -Depth 12), $taskUtf8)
    if (-not $PrepareOnly) {
        $taskBuild.compiler = [ordered]@{ name = [IO.Path]::GetFileName($taskCompiler); sha256 = Get-BuildHash $taskCompiler }
        Push-Location $taskOutput
        try { Invoke-BuildProgram $taskCompiler @('/Qp', 'wizard.iss') | Out-Null } finally { Pop-Location }
        $taskExe = Assert-RegularFile (Join-Path $taskOutput ('output\' + $taskOutputName + '.exe')) 4294967296
        $taskBuild.installer = [ordered]@{ path = $taskExe; size = (Get-Item -LiteralPath $taskExe).Length; sha256 = Get-BuildHash $taskExe }
        $taskBuild.compiled = $true
        $taskBuild.developerArtifact = $false
        [IO.File]::WriteAllText($taskInfoPath, ($taskBuild | ConvertTo-Json -Depth 12), $taskUtf8)
    }
    if ((Get-BuildHash $PSCommandPath) -cne $taskBuilder.sha256) { throw 'Installer build script changed during the build.' }
    $taskBuild.completed = $true
    [IO.File]::WriteAllText($taskInfoPath, ($taskBuild | ConvertTo-Json -Depth 12), $taskUtf8)
    $taskBuild | ConvertTo-Json -Depth 12
} finally {
    if ($taskTicket) {
        try { Invoke-BuildProgram $taskHelper @('installer', 'abort', '--root', $taskValidation, '--ticket', $taskTicket) | Out-Null }
        catch { [Console]::Error.WriteLine('Private validation ticket cleanup failed; build temporary files will be removed safely.') }
    }
    Remove-PrivateStage $taskStage
}
