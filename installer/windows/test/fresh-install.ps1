[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][ValidateSet('normal', 'baseline')][string]$Variant,
    [Parameter(Mandatory = $true)][string]$ReportDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if (-not $env:GITHUB_ACTIONS -or -not $env:RUNNER_TEMP) { throw 'This test requires an ephemeral GitHub-hosted Windows runner.' }
$taskCandidate = Get-Content -LiteralPath $CandidatePath -Raw | ConvertFrom-Json
if ($taskCandidate.schema -ne 1 -or $taskCandidate.repository -cne 'victorccronemberger-blip/cudia' -or
    $taskCandidate.channel -cne 'preview' -or $taskCandidate.version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+[-+0-9A-Za-z.]*$') { throw 'Invalid candidate identity.' }
$taskArtifact = $taskCandidate.artifacts | Where-Object { $_.variant -ceq $Variant }
if (@($taskArtifact).Count -ne 1 -or $taskArtifact.assetId -lt 1 -or $taskArtifact.size -lt 1 -or
    $taskArtifact.size -gt 2147483648 -or $taskArtifact.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $taskArtifact.engineSha256 -cnotmatch '^[a-f0-9]{64}$' -or $taskArtifact.bootstrapSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid pinned artifact.' }
$taskReports = [IO.Path]::GetFullPath($ReportDirectory)
$taskRunner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $taskReports.StartsWith($taskRunner, [StringComparison]::OrdinalIgnoreCase)) { throw 'Reports must stay inside runner temp.' }
[IO.Directory]::CreateDirectory($taskReports) | Out-Null
$taskDirectory = Join-Path $taskReports ('fresh-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskDirectory) | Out-Null
$taskRoot = Join-Path $taskDirectory ('CUDIA instala' + [char]0xE7 + [char]0xE3 + 'o')
$taskWorkspace = Join-Path $taskDirectory ('outro projeto ' + [char]0xFC)
$taskProfile = Join-Path $taskDirectory 'perfil vazio'
[IO.Directory]::CreateDirectory($taskWorkspace) | Out-Null
[IO.Directory]::CreateDirectory($taskProfile) | Out-Null
$taskSetup = Join-Path $taskDirectory 'CUDIA-Setup.exe'
$taskRegistration = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\CudiaPreview'
$taskResult = [ordered]@{ completed = $false; variant = $Variant; version = $taskCandidate.version; stage = 'preflight'; windows = [Environment]::OSVersion.VersionString; temporaryDirectory = [IO.Path]::GetTempPath(); cacheDirectory = [Environment]::GetFolderPath('LocalApplicationData'); lockProbe = $null; installerSha256 = $null; engineSha256 = $null; physicalBootstrap = $null; persistentPathCount = $null; commandVersion = $null; contextMode = $null; coldCatalogPassed = $false; removalVerified = $false; pathProbe = $null; error = $null }
function Save-TaskReport { $taskResult | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskReports 'result.json') -Encoding utf8 }
function Get-RegistrySnapshot([string]$Subkey) {
    $taskKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Subkey, $false)
    if ($null -eq $taskKey) { return 'null' }
    try {
        $taskValues = [ordered]@{}
        foreach ($taskName in ($taskKey.GetValueNames() | Sort-Object)) {
            $taskValues[$taskName] = [ordered]@{ kind = $taskKey.GetValueKind($taskName).ToString(); value = $taskKey.GetValue($taskName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        }
        return ($taskValues | ConvertTo-Json -Depth 8 -Compress)
    } finally { $taskKey.Dispose() }
}
function Get-UninstallNames {
    $taskKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
    if ($null -eq $taskKey) { return '' }
    try { return (($taskKey.GetSubKeyNames() | Sort-Object) -join '|') } finally { $taskKey.Dispose() }
}
function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-Physical([string]$Path) {
    $taskFile = [IO.File]::OpenRead($Path)
    try {
        $taskValue = New-Object Text.StringBuilder 32768
        $taskCount = [CudiaFreshPhysical]::GetFinalPathNameByHandle($taskFile.SafeFileHandle, $taskValue, $taskValue.Capacity, 0)
        if ($taskCount -eq 0 -or $taskCount -ge $taskValue.Capacity) { throw 'Cannot resolve physical file.' }
        return $taskValue.ToString()
    } finally { $taskFile.Dispose() }
}
Save-TaskReport
try {
    $taskPrior = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($taskRegistration, $false)
    if ($null -ne $taskPrior) { $taskPrior.Dispose(); throw 'Runner already has CUDIA registration; refusing to touch it.' }
    if (Get-Command cudia -ErrorAction SilentlyContinue) { throw 'Runner already resolves CUDIA.' }
    $taskBeforeEnvironment = Get-RegistrySnapshot 'Environment'
    $taskBeforeNames = Get-UninstallNames
    $taskBeforeMachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskPolicy = 'O:' + $taskSid + 'D:P(A;;GA;;;SY)(A;;GA;;;' + $taskSid + ')'
    $taskSecurity = New-Object Security.AccessControl.MutexSecurity
    $taskSecurity.SetSecurityDescriptorSddlForm($taskPolicy)
    $taskCreated = $false
    $taskProbe = [Threading.Mutex]::new($false, ('Global\Cudia-CI-PolicyProbe-' + [guid]::NewGuid().ToString('N')), [ref]$taskCreated, $taskSecurity)
    try {
        $taskResult.lockProbe = [ordered]@{ requested = $taskPolicy; actual = $taskProbe.GetAccessControl().GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access) }
    } finally { $taskProbe.Dispose() }
    $taskResult.stage = 'downloading'
    Save-TaskReport
    Add-Type -AssemblyName System.Net.Http
    $taskHandler = New-Object Net.Http.HttpClientHandler
    $taskHandler.AllowAutoRedirect = $false
    $taskHttp = New-Object Net.Http.HttpClient($taskHandler)
    $taskHttp.Timeout = [TimeSpan]::FromMinutes(3)
    $taskTimeout = New-Object Threading.CancellationTokenSource
    $taskTimeout.CancelAfter([TimeSpan]::FromMinutes(3))
    $taskUrl = [Uri]('https://api.github.com/repos/' + $taskCandidate.repository + '/releases/assets/' + $taskArtifact.assetId)
    # A job token is used only on the fixed GitHub API host and removed before
    # starting any installer or runtime process. It never enters the candidate.
    $taskToken = $env:CUDIA_CI_DOWNLOAD_TOKEN
    [Environment]::SetEnvironmentVariable('CUDIA_CI_DOWNLOAD_TOKEN', $null, 'Process')
    [Environment]::SetEnvironmentVariable('GITHUB_TOKEN', $null, 'Process')
    try {
        for ($taskRedirect = 0; $taskRedirect -le 5; $taskRedirect++) {
            if ($taskUrl.Scheme -cne 'https' -or $taskUrl.Host -notin @('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) { throw 'Unexpected asset redirect.' }
            $taskRequest = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, $taskUrl)
            $taskRequest.Headers.UserAgent.ParseAdd('CUDIA-fresh-install-validation/1')
            $taskRequest.Headers.Accept.ParseAdd('application/octet-stream')
            if ($taskUrl.Host -ceq 'api.github.com' -and $taskToken) { $taskRequest.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $taskToken) }
            $taskResponse = $taskHttp.SendAsync($taskRequest, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $taskTimeout.Token).GetAwaiter().GetResult()
            try {
                if ([int]$taskResponse.StatusCode -in @(301, 302, 303, 307, 308)) {
                    if ($taskRedirect -eq 5) { throw 'Asset redirect limit exceeded.' }
                    $taskUrl = New-Object Uri($taskUrl, $taskResponse.Headers.Location)
                    continue
                }
                if ([int]$taskResponse.StatusCode -ne 200) { throw ('Candidate asset HTTP status ' + [int]$taskResponse.StatusCode) }
                $taskInput = $taskResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                $taskOutput = [IO.File]::Open($taskSetup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    $taskBuffer = New-Object byte[] 65536
                    $taskTotal = 0L
                    while (($taskRead = $taskInput.ReadAsync($taskBuffer, 0, $taskBuffer.Length, $taskTimeout.Token).GetAwaiter().GetResult()) -gt 0) {
                        $taskTotal += $taskRead
                        if ($taskTotal -gt $taskArtifact.size) { throw 'Oversized candidate asset.' }
                        $taskOutput.Write($taskBuffer, 0, $taskRead)
                    }
                    if ($taskTotal -ne $taskArtifact.size) { throw 'Truncated candidate asset.' }
                } finally { $taskOutput.Dispose(); $taskInput.Dispose() }
                break
            } finally { $taskResponse.Dispose(); $taskRequest.Dispose() }
        }
    } finally { $taskTimeout.Dispose(); $taskHttp.Dispose(); $taskHandler.Dispose(); $taskToken = $null }
    $taskResult.installerSha256 = Get-Hash $taskSetup
    if ($taskResult.installerSha256 -cne $taskArtifact.sha256) { throw 'Candidate installer hash differs.' }
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CudiaFreshPhysical {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetTempPath2W(uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetLongPathNameW(string path, StringBuilder value, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder value, uint length, uint flags);
}
'@
    $taskResult.stage = 'installing'
    Save-TaskReport
    $taskInstallLog = Join-Path $taskReports 'setup.log'
    $taskProcess = Start-Process -FilePath $taskSetup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', ('/DIR="' + $taskRoot + '"'), ('/LOG="' + $taskInstallLog + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($taskProcess.ExitCode -ne 0) { throw ('Installer failed with exit ' + $taskProcess.ExitCode) }
    $taskBootstrap = Join-Path $taskRoot 'bin\cudia.exe'
    $taskResult.physicalBootstrap = Get-Physical $taskBootstrap
    if ($taskResult.physicalBootstrap -cne ('\\?\' + $taskBootstrap) -or (Get-Hash $taskBootstrap) -cne $taskArtifact.bootstrapSha256) { throw 'Bootstrap is redirected or differs.' }
    $taskInfo = & $taskBootstrap installation info | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $taskInfo.state.highestSequence -ne $taskCandidate.sequence -or $taskInfo.state.variant -cne $Variant) { throw 'Installed identity differs.' }
    $taskEngine = Join-Path $taskRoot ('versions\' + $taskInfo.state.selectedReleaseId + '\runtime\engine.exe')
    $taskResult.engineSha256 = Get-Hash $taskEngine
    if ($taskResult.engineSha256 -cne $taskArtifact.engineSha256 -or (Get-Physical $taskEngine) -cne ('\\?\' + $taskEngine)) { throw 'Installed engine differs.' }
    $taskPersisted = [Environment]::GetEnvironmentVariable('Path', 'User')
    $taskBin = Join-Path $taskRoot 'bin'
    $taskEntries = @($taskPersisted -split ';' | Where-Object { $_.TrimEnd('\') -ieq $taskBin })
    $taskResult.persistentPathCount = $taskEntries.Count
    if ($taskEntries.Count -ne 1) { throw 'Persistent PATH does not contain exactly one CUDIA entry.' }
    $taskKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($taskRegistration, $false)
    if ($null -eq $taskKey) { throw 'Installed apps registration missing.' }
    try {
        if ($taskKey.GetValue('InstallLocation') -cne $taskRoot -or $taskKey.GetValue('DisplayVersion') -cne $taskCandidate.version) { throw 'Installed apps registration differs.' }
    } finally { $taskKey.Dispose() }
    # Only the entry obtained from persistent PATH and Windows system commands
    # are visible. Runner-installed Node/Bun/Git cannot satisfy runtime needs.
    $env:Path = $taskEntries[0] + ';' + (Join-Path $env:SystemRoot 'System32')
    foreach ($taskPair in @{ OPENCODE_TEST_HOME = $taskProfile; OPENCODE_CONFIG_DIR = (Join-Path $taskProfile 'config'); XDG_CONFIG_HOME = (Join-Path $taskProfile 'config'); XDG_DATA_HOME = (Join-Path $taskProfile 'data'); XDG_CACHE_HOME = (Join-Path $taskProfile 'cache'); XDG_STATE_HOME = (Join-Path $taskProfile 'state') }.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($taskPair.Key, $taskPair.Value, 'Process')
    }
    Set-Location -LiteralPath $taskWorkspace
    $taskResult.stage = 'cold-launch'
    Save-TaskReport
    $taskVersion = & (Join-Path $env:SystemRoot 'System32\cmd.exe') /d /c 'cudia --version'
    if ($LASTEXITCODE -ne 0 -or $taskVersion.Trim() -cne $taskCandidate.version) { throw 'Ordinary CMD did not resolve the expected version.' }
    $taskResult.commandVersion = $taskVersion.Trim()
    $taskMode = & $taskBootstrap debug context --status | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $taskMode.ambientInstructions.automatic -ne $false) { throw 'Cold context mode differs.' }
    $taskResult.contextMode = $taskMode.ambientInstructions
    $taskCatalog = & $taskBootstrap models --refresh
    if ($LASTEXITCODE -ne 0 -or ($taskCatalog -join "`n") -match '(?m)^opencode(?:-go)?/') { throw 'Cold model catalog failed or activated an OpenCode provider.' }
    $taskResult.coldCatalogPassed = $true
    $taskSentinel = Join-Path $taskProfile 'preserve-user-data.txt'
    [IO.File]::WriteAllText($taskSentinel, 'CUDIA fresh-install validation user data')
    $taskResult.stage = 'uninstalling'
    Save-TaskReport
    & (Join-Path $taskRoot 'maintenance\launcher.exe') installer uninstall --root $taskRoot --quiet
    if ($LASTEXITCODE -ne 0) {
        $taskTempBuffer = New-Object Text.StringBuilder 32768
        $taskTempLength = [CudiaFreshPhysical]::GetTempPath2W($taskTempBuffer.Capacity, $taskTempBuffer)
        $taskGoTemp = $taskTempBuffer.ToString().TrimEnd('\')
        $taskProbePaths = @([IO.Path]::GetTempPath().TrimEnd('\'), $taskGoTemp, [Environment]::GetFolderPath('LocalApplicationData'), $taskRoot, (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
        $taskRecovery = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CudiaMaintenanceRecovery'
        if (Test-Path -LiteralPath $taskRecovery) { $taskProbePaths += @(Get-ChildItem -LiteralPath $taskRecovery -Recurse -Force | Select-Object -First 24 -ExpandProperty FullName) }
        $taskResult.pathProbe = @($taskProbePaths | ForEach-Object {
            $taskExisting = $_
            while (-not (Test-Path -LiteralPath $taskExisting)) { $taskExisting = Split-Path -Parent $taskExisting }
            $taskLongBuffer = New-Object Text.StringBuilder 32768
            $taskLongLength = [CudiaFreshPhysical]::GetLongPathNameW($taskExisting, $taskLongBuffer, $taskLongBuffer.Capacity)
            [pscustomobject]@{ path = $_; existing = $taskExisting; long = $taskLongBuffer.ToString(); length = $taskLongLength; matches = $taskExisting -ieq $taskLongBuffer.ToString() }
        })
        throw 'Uninstaller failed.'
    }
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $taskAfter = Get-RegistrySnapshot $taskRegistration
        if ($taskAfter -eq 'null' -and -not (Test-Path -LiteralPath $taskBootstrap)) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if ((Get-RegistrySnapshot $taskRegistration) -ne 'null' -or (Test-Path -LiteralPath $taskBootstrap)) { throw 'Owned installation removal incomplete.' }
    if ((Get-RegistrySnapshot 'Environment') -cne $taskBeforeEnvironment -or (Get-UninstallNames) -cne $taskBeforeNames -or [Environment]::GetEnvironmentVariable('Path', 'Machine') -cne $taskBeforeMachinePath) { throw 'Unrelated registry or PATH state changed.' }
    if ([IO.File]::ReadAllText($taskSentinel) -cne 'CUDIA fresh-install validation user data') { throw 'User data changed on removal.' }
    $taskResult.removalVerified = $true
    $taskResult.completed = $true
    $taskResult.stage = 'complete'
} catch {
    $taskResult.error = $_.Exception.Message
    $taskResult.stage = 'failed'
    throw
} finally { Save-TaskReport }
