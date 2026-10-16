[CmdletBinding()]
param(
    [string]$GoPath = 'go',
    [string]$PublicKeysPath,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$taskGo = (Get-Command $GoPath -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskModule = Join-Path $PSScriptRoot 'launcher'
$taskUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$taskBuilder = [IO.Path]::GetFullPath($PSCommandPath)
$taskBuilderFile = Get-Item -LiteralPath $taskBuilder -Force
if ($taskBuilderFile.PSIsContainer -or ($taskBuilderFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Build script must be a regular file.'
}
$taskGoFile = Get-Item -LiteralPath $taskGo -Force
if ($taskGoFile.PSIsContainer -or ($taskGoFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'GoPath must resolve to a regular executable file.'
}
$taskTrust = '{}'
if ($PublicKeysPath) {
    $taskTrustFile = Get-Item -LiteralPath $PublicKeysPath -Force
    if ($taskTrustFile.PSIsContainer -or $taskTrustFile.Length -gt 16384 -or ($taskTrustFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Public keyring must be a regular JSON file of at most 16 KiB.'
    }
    $taskTrust = $taskUtf8.GetString([IO.File]::ReadAllBytes($taskTrustFile.FullName))
    if ($taskTrust -match 'PRIVATE KEY') { throw 'Only public release keys belong in a client build.' }
    $taskParsedTrust = $taskTrust | ConvertFrom-Json
    if ($null -eq $taskParsedTrust -or $taskParsedTrust -is [Array] -or $taskParsedTrust -is [string] -or
        $taskParsedTrust -is [ValueType] -or @($taskParsedTrust.PSObject.Properties).Count -gt 8) { throw 'Invalid public keyring.' }
}

function Get-BuildHash([string]$Path) {
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    $taskStream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($taskHasher.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskHasher.Dispose() }
}

function Get-SourceSnapshot([string]$Root) {
    $taskSnapshot = [ordered]@{}
    $taskPrefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    foreach ($taskSourceFile in (Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Sort-Object FullName)) {
        if ($taskSourceFile.Extension -ne '.go' -and $taskSourceFile.Name -ne 'go.mod' -and $taskSourceFile.Name -ne 'trust.json') { continue }
        $taskRelative = $taskSourceFile.FullName.Substring($taskPrefix.Length).Replace('\', '/')
        if ($taskRelative.StartsWith('dist/', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $taskSnapshot[$taskRelative] = [ordered]@{ size = $taskSourceFile.Length; sha256 = Get-BuildHash $taskSourceFile.FullName }
    }
    return $taskSnapshot
}

$taskBuilderSize = $taskBuilderFile.Length
$taskBuilderHash = Get-BuildHash $taskBuilder
$taskGoSize = $taskGoFile.Length
$taskGoHash = Get-BuildHash $taskGo
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot ('dist\client-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $taskOutput) { throw 'Choose a new output directory; existing builds are preserved.' }
$taskStage = Join-Path ([IO.Path]::GetTempPath()) ('cudia-client-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskStage | Out-Null
$taskPrevious = @{}
foreach ($taskName in @('CGO_ENABLED', 'GOTOOLCHAIN', 'GOOS', 'GOARCH')) {
    $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
}
try {
    # Copy source, not a checkout's binaries, dependency directories or credentials.
    $taskPrefix = [IO.Path]::GetFullPath($taskModule).TrimEnd('\') + '\'
    foreach ($taskFile in (Get-ChildItem -LiteralPath $taskModule -File -Recurse -Force)) {
        if ($taskFile.Extension -ne '.go' -and $taskFile.Name -ne 'go.mod') { continue }
        if ($taskFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source aliases are not accepted.' }
        $taskRelative = $taskFile.FullName.Substring($taskPrefix.Length)
        if ($taskRelative.StartsWith('dist\', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $taskDestination = Join-Path $taskStage $taskRelative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskDestination)) | Out-Null
        [IO.File]::Copy($taskFile.FullName, $taskDestination)
    }
    [IO.File]::WriteAllText((Join-Path $taskStage 'internal\client\trust.json'), $taskTrust, $taskUtf8)
    $taskSourceFiles = Get-SourceSnapshot $taskStage
    $env:CGO_ENABLED = '0'
    $env:GOTOOLCHAIN = 'local'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $taskGoVersionOutput = & $taskGo version
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Go toolchain version.' }
    $taskGoVersion = ($taskGoVersionOutput -join ' ').Trim()
    if (-not $taskGoVersion) { throw 'Go returned an empty toolchain version.' }
    Push-Location $taskStage
    try {
        & $taskGo build -trimpath -ldflags '-s -w' -o (Join-Path $taskStage 'cudia.exe') ./cmd/bootstrap
        if ($LASTEXITCODE -ne 0) { throw 'Bootstrap build failed.' }
        & $taskGo build -trimpath -ldflags '-s -w' -o (Join-Path $taskStage 'launcher.exe') ./cmd/launcher
        if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }
    } finally { Pop-Location }
    $taskSourceFilesAfterBuild = Get-SourceSnapshot $taskStage
    if (($taskSourceFiles | ConvertTo-Json -Depth 8 -Compress) -cne ($taskSourceFilesAfterBuild | ConvertTo-Json -Depth 8 -Compress)) {
        throw 'Frozen Go source inputs changed during compilation.'
    }
    if ((Get-Item -LiteralPath $taskGo -Force).Length -ne $taskGoSize -or (Get-BuildHash $taskGo) -cne $taskGoHash) {
        throw 'Go executable changed during compilation.'
    }
    if ((Get-Item -LiteralPath $taskBuilder -Force).Length -ne $taskBuilderSize -or (Get-BuildHash $taskBuilder) -cne $taskBuilderHash) {
        throw 'Build script changed during compilation.'
    }
    $taskTrustInfo = & (Join-Path $taskStage 'launcher.exe') trust-info
    if ($LASTEXITCODE -ne 0) { throw 'Compiled public keyring validation failed.' }
    $taskValidatedTrust = ($taskTrustInfo -join "`n") | ConvertFrom-Json
    [IO.Directory]::CreateDirectory($taskOutput) | Out-Null
    [IO.File]::Move((Join-Path $taskStage 'cudia.exe'), (Join-Path $taskOutput 'cudia.exe'))
    [IO.File]::Move((Join-Path $taskStage 'launcher.exe'), (Join-Path $taskOutput 'launcher.exe'))
    [IO.File]::WriteAllText((Join-Path $taskOutput 'trust-info.json'), ($taskValidatedTrust | ConvertTo-Json -Depth 10), $taskUtf8)
    if ((Get-Item -LiteralPath $taskGo -Force).Length -ne $taskGoSize -or (Get-BuildHash $taskGo) -cne $taskGoHash) {
        throw 'Go executable changed before the build completed.'
    }
    if ((Get-Item -LiteralPath $taskBuilder -Force).Length -ne $taskBuilderSize -or (Get-BuildHash $taskBuilder) -cne $taskBuilderHash) {
        throw 'Build script changed before the build completed.'
    }
    $taskBuildInfo = [ordered]@{
        schema = 1
        product = 'cudia'
        kind = 'windows-client-build'
        source = [ordered]@{
            builder = [ordered]@{ size = $taskBuilderSize; sha256 = $taskBuilderHash }
            files = $taskSourceFiles
        }
        build = [ordered]@{
            goVersion = $taskGoVersion
            goExecutable = [ordered]@{ size = $taskGoSize; sha256 = $taskGoHash }
            powershellVersion = $PSVersionTable.PSVersion.ToString()
            powershellEdition = $PSVersionTable.PSEdition
            environment = [ordered]@{ CGO_ENABLED = '0'; GOTOOLCHAIN = 'local'; GOOS = 'windows'; GOARCH = 'amd64' }
            arguments = [ordered]@{
                bootstrap = @('build', '-trimpath', '-ldflags', '-s -w', '-o', '<temporary-output>', './cmd/bootstrap')
                launcher = @('build', '-trimpath', '-ldflags', '-s -w', '-o', '<temporary-output>', './cmd/launcher')
            }
        }
        trust = $taskValidatedTrust
        outputs = [ordered]@{
            'cudia.exe' = [ordered]@{ size = (Get-Item -LiteralPath (Join-Path $taskOutput 'cudia.exe')).Length; sha256 = Get-BuildHash (Join-Path $taskOutput 'cudia.exe') }
            'launcher.exe' = [ordered]@{ size = (Get-Item -LiteralPath (Join-Path $taskOutput 'launcher.exe')).Length; sha256 = Get-BuildHash (Join-Path $taskOutput 'launcher.exe') }
        }
    }
    $taskBuildInfoBytes = $taskUtf8.GetBytes(($taskBuildInfo | ConvertTo-Json -Depth 12))
    if ($taskBuildInfoBytes.Length -gt 1048576) { throw 'Client build provenance exceeds 1 MiB.' }
    $taskBuildInfoPath = Join-Path $taskOutput 'client-build.json'
    [IO.File]::WriteAllBytes($taskBuildInfoPath, $taskBuildInfoBytes)
    [ordered]@{
        bootstrap = Join-Path $taskOutput 'cudia.exe'
        launcher = Join-Path $taskOutput 'launcher.exe'
        buildInfo = $taskBuildInfoPath
        trust = $taskValidatedTrust
    } | ConvertTo-Json -Depth 12
} finally {
    foreach ($taskName in $taskPrevious.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') }
    $taskResolved = [IO.Path]::GetFullPath($taskStage)
    $taskTempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($taskResolved.StartsWith($taskTempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $taskResolved) -match '^cudia-client-build-[a-f0-9]{32}$' -and
        (Test-Path -LiteralPath $taskResolved -PathType Container)) {
        $taskReparse = Get-ChildItem -LiteralPath $taskResolved -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
        if (-not $taskReparse -and -not ((Get-Item -LiteralPath $taskResolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $taskResolved -Recurse -Force
        }
    }
}
