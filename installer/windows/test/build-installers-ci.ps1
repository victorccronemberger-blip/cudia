[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][ValidateSet('normal', 'baseline')][string]$Variant,
    [Parameter(Mandatory = $true)][string]$ReportDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if (-not $env:GITHUB_ACTIONS -or -not $env:RUNNER_TEMP) { throw 'Installer builds require an ephemeral GitHub-hosted Windows runner.' }
$taskUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$taskRunnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$taskReports = [IO.Path]::GetFullPath($ReportDirectory)
if (-not $taskReports.StartsWith($taskRunnerTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Report directory must remain inside RUNNER_TEMP.' }
$taskReportCheck = $taskReports
while ($taskReportCheck -and $taskReportCheck.StartsWith($taskRunnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $taskReportCheck) {
        if ((Get-Item -LiteralPath $taskReportCheck -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Report directory path cannot contain aliases.' }
    }
    $taskReportCheck = [IO.Path]::GetDirectoryName($taskReportCheck)
}
[IO.Directory]::CreateDirectory($taskReports) | Out-Null
$taskReportPath = Join-Path $taskReports ('build-info-' + $Variant + '.json')
$taskCandidate = Get-Content -LiteralPath $CandidatePath -Raw | ConvertFrom-Json
if ($taskCandidate.schema -ne 1 -or $taskCandidate.repository -cne 'victorccronemberger-blip/cudia' -or
    $taskCandidate.channel -cne 'preview' -or $taskCandidate.sequence -isnot [ValueType] -or
    [decimal]$taskCandidate.sequence -lt 1 -or [decimal]$taskCandidate.sequence -ne [math]::Truncate([decimal]$taskCandidate.sequence) -or
    $taskCandidate.version -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+cudia\.preview\d+\.\d{8}$' -or
    $taskCandidate.releaseId -isnot [ValueType] -or [long]$taskCandidate.releaseId -lt 1 -or
    $taskCandidate.tag -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $taskCandidate.sequence -gt 9007199254740991) {
    throw 'Invalid preview installer candidate identity.'
}
$taskBundle = $taskCandidate.buildBundle
if ($null -eq $taskBundle -or $taskBundle.id -isnot [ValueType] -or [long]$taskBundle.id -lt 1 -or
    $taskBundle.size -isnot [ValueType] -or [long]$taskBundle.size -lt 1 -or [long]$taskBundle.size -gt 1073741824 -or
    $taskBundle.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid bounded build input asset descriptor.' }
if ($taskCandidate.version -notmatch ('\+cudia\.preview' + [regex]::Escape([string]$taskCandidate.sequence) + '\.')) {
    throw 'Candidate version and sequence disagree.'
}

function Get-FileSha256([string]$Path) {
    $taskHash = [Security.Cryptography.SHA256]::Create()
    $taskStream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($taskHash.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskHash.Dispose() }
}

$taskToken = $env:CUDIA_CI_GITHUB_TOKEN
if (-not $taskToken) { throw 'GitHub token was not provided to the CI downloader.' }
[Environment]::SetEnvironmentVariable('CUDIA_CI_GITHUB_TOKEN', $null, 'Process')
$taskTemp = Join-Path $env:RUNNER_TEMP ('cudia-installer-inputs-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskTemp) | Out-Null
$taskZipPath = Join-Path $taskTemp 'build-inputs.zip'
$taskExtract = Join-Path $taskTemp 'inputs'
$taskSetup = Join-Path $taskTemp ('CUDIA-Preview-Setup-windows-x64-' + $Variant + '.exe')
$taskUploadToken = $taskToken
$taskToken = $null
try {
    Add-Type -AssemblyName System.Net.Http
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskHandler = New-Object Net.Http.HttpClientHandler
    $taskHandler.AllowAutoRedirect = $false
    $taskHttp = New-Object Net.Http.HttpClient($taskHandler)
    $taskHttp.Timeout = [TimeSpan]::FromMinutes(4)
    $taskTimeout = New-Object Threading.CancellationTokenSource
    $taskTimeout.CancelAfter([TimeSpan]::FromMinutes(4))
    $taskReleaseRequest = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, ('https://api.github.com/repos/' + $taskCandidate.repository + '/releases/' + [long]$taskCandidate.releaseId))
    $taskReleaseRequest.Headers.UserAgent.ParseAdd('CUDIA-preview-installer-builder/1')
    $taskReleaseRequest.Headers.Accept.ParseAdd('application/vnd.github+json')
    $taskReleaseRequest.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $taskUploadToken)
    $taskReleaseResponse = $taskHttp.SendAsync($taskReleaseRequest, $taskTimeout.Token).GetAwaiter().GetResult()
    try {
        if ([int]$taskReleaseResponse.StatusCode -ne 200) { throw ('Candidate release lookup HTTP status ' + [int]$taskReleaseResponse.StatusCode) }
        $taskRelease = $taskReleaseResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        if ([long]$taskRelease.id -ne [long]$taskCandidate.releaseId -or $taskRelease.draft -ne $true -or $taskRelease.tag_name -cne $taskCandidate.tag) {
            throw 'Candidate release id, draft state, and tag do not match the GitHub release.'
        }
    } finally { $taskReleaseResponse.Dispose(); $taskReleaseRequest.Dispose() }
    $taskUrl = [Uri]('https://api.github.com/repos/' + $taskCandidate.repository + '/releases/assets/' + [long]$taskBundle.id)
    try {
        for ($taskRedirect = 0; $taskRedirect -le 5; $taskRedirect++) {
            if ($taskUrl.Scheme -cne 'https' -or $taskUrl.Host -notin @('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) { throw 'Unexpected build asset redirect.' }
            $taskRequest = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, $taskUrl)
            $taskRequest.Headers.UserAgent.ParseAdd('CUDIA-preview-installer-builder/1')
            $taskRequest.Headers.Accept.ParseAdd('application/octet-stream')
            if ($taskUrl.Host -ceq 'api.github.com') { $taskRequest.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $taskUploadToken) }
            $taskResponse = $taskHttp.SendAsync($taskRequest, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $taskTimeout.Token).GetAwaiter().GetResult()
            try {
                if ([int]$taskResponse.StatusCode -in @(301, 302, 303, 307, 308)) {
                    if ($taskRedirect -eq 5) { throw 'Build asset redirect limit exceeded.' }
                    $taskUrl = New-Object Uri($taskUrl, $taskResponse.Headers.Location)
                    continue
                }
                if ([int]$taskResponse.StatusCode -ne 200) { throw ('Build asset HTTP status ' + [int]$taskResponse.StatusCode) }
                if ($taskResponse.Content.Headers.ContentLength -ne [long]$taskBundle.size) { throw 'Build asset Content-Length differs from candidate.' }
                $taskInput = $taskResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                $taskOutput = [IO.File]::Open($taskZipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    $taskBuffer = New-Object byte[] 65536
                    $taskTotal = 0L
                    while (($taskRead = $taskInput.ReadAsync($taskBuffer, 0, $taskBuffer.Length, $taskTimeout.Token).GetAwaiter().GetResult()) -gt 0) {
                        $taskTotal += $taskRead
                        if ($taskTotal -gt [long]$taskBundle.size -or $taskTotal -gt 1073741824) { throw 'Build asset exceeds its declared size limit.' }
                        $taskOutput.Write($taskBuffer, 0, $taskRead)
                    }
                    if ($taskTotal -ne [long]$taskBundle.size) { throw 'Build asset download is incomplete.' }
                } finally { $taskOutput.Dispose(); $taskInput.Dispose() }
                break
            } finally { $taskResponse.Dispose(); $taskRequest.Dispose() }
        }
    } finally { $taskTimeout.Dispose(); $taskHttp.Dispose(); $taskHandler.Dispose() }
    if ((Get-FileSha256 $taskZipPath) -cne $taskBundle.sha256) { throw 'Build asset SHA-256 differs from candidate.' }

    $taskArchive = [IO.Compression.ZipFile]::OpenRead($taskZipPath)
    try {
        $taskExpected = @('cudia.exe', 'launcher.exe', 'client-build.json', 'installation-preview.json',
            ('cudia-windows-x64-normal-seq' + $taskCandidate.sequence + '.zip'),
            ('cudia-windows-x64-baseline-seq' + $taskCandidate.sequence + '.zip'))
        $taskNames = @()
        $taskExpandedTotal = 0L
        foreach ($taskEntry in $taskArchive.Entries) {
            $taskName = $taskEntry.FullName
            if ($taskName -notin $taskExpected -or $taskName.Contains('/') -or $taskName.Contains('\') -or $taskName.Contains(':') -or $taskName -match '[\x00-\x1f]') { throw 'Build ZIP contains an unexpected or unsafe path.' }
            if ($taskNames -ccontains $taskName) { throw 'Build ZIP contains a duplicate entry.' }
            $taskNames += $taskName
            $taskExpandedTotal += [long]$taskEntry.Length
            if ($taskExpandedTotal -gt 5368709120) { throw 'Build ZIP expanded contents exceed the limit.' }
            if ($taskName -in @('cudia.exe', 'launcher.exe') -and ($taskEntry.Length -lt 1 -or $taskEntry.Length -gt 67108864)) { throw 'Build executable input exceeds its limit.' }
            if ($taskName -eq 'client-build.json' -and $taskEntry.Length -gt 1048576) { throw 'Client provenance exceeds its limit.' }
            if ($taskName -eq 'installation-preview.json' -and ($taskEntry.Length -lt 1 -or $taskEntry.Length -gt 65536)) { throw 'Release manifest exceeds its limit.' }
            if ($taskName -like '*.zip' -and ($taskEntry.Length -lt 1 -or $taskEntry.Length -gt 2147483648)) { throw 'Runtime archive exceeds its limit.' }
        }
        if ($taskNames.Count -ne $taskExpected.Count -or @($taskExpected | Where-Object { $taskNames -cnotcontains $_ }).Count -ne 0) { throw 'Build ZIP is missing required inputs.' }
        [IO.Directory]::CreateDirectory($taskExtract) | Out-Null
        foreach ($taskEntry in $taskArchive.Entries) {
            $taskDestination = Join-Path $taskExtract $taskEntry.FullName
            $taskIn = $taskEntry.Open()
            $taskOut = [IO.File]::Open($taskDestination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $taskBuffer = New-Object byte[] 65536
                $taskWritten = 0L
                while (($taskRead = $taskIn.Read($taskBuffer, 0, $taskBuffer.Length)) -gt 0) {
                    $taskWritten += $taskRead
                    if ($taskWritten -gt [long]$taskEntry.Length) { throw 'Build ZIP entry exceeded its declared size.' }
                    $taskOut.Write($taskBuffer, 0, $taskRead)
                }
                if ($taskWritten -ne [long]$taskEntry.Length) { throw 'Build ZIP entry was truncated.' }
            } finally { $taskOut.Dispose(); $taskIn.Dispose() }
        }
    } finally { $taskArchive.Dispose() }

    $taskClientStream = [IO.File]::OpenRead((Join-Path $taskExtract 'client-build.json'))
    try {
        if ($taskClientStream.Length -gt 1048576) { throw 'Client provenance exceeds its limit.' }
        $taskReader = New-Object IO.StreamReader($taskClientStream, $taskUtf8)
        try { $taskClientBuild = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
    } finally { $taskClientStream.Dispose() }
    if ($taskClientBuild.schema -ne 1 -or $taskClientBuild.product -cne 'cudia' -or $taskClientBuild.kind -cne 'windows-client-build' -or
        $taskClientBuild.outputs.'cudia.exe'.sha256 -cne (Get-FileSha256 (Join-Path $taskExtract 'cudia.exe')) -or
        $taskClientBuild.outputs.'cudia.exe'.size -ne (Get-Item -LiteralPath (Join-Path $taskExtract 'cudia.exe')).Length -or
        $taskClientBuild.outputs.'launcher.exe'.sha256 -cne (Get-FileSha256 (Join-Path $taskExtract 'launcher.exe')) -or
        $taskClientBuild.outputs.'launcher.exe'.size -ne (Get-Item -LiteralPath (Join-Path $taskExtract 'launcher.exe')).Length) {
        throw 'Client build provenance does not match the downloaded executables.'
    }

    $taskIscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    if (-not (Test-Path -LiteralPath $taskIscc -PathType Leaf)) {
        $taskIsccCommand = Get-Command 'ISCC.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($taskIsccCommand) { $taskIscc = $taskIsccCommand.Source }
    }
    if (-not (Test-Path -LiteralPath $taskIscc -PathType Leaf)) { throw 'Preinstalled Inno Setup ISCC.exe was not found on windows-2025; this job will not download or install a compiler.' }

    $taskArchiveName = 'cudia-windows-x64-' + $Variant + '-seq' + $taskCandidate.sequence + '.zip'
    $taskBuildOut = Join-Path $taskTemp 'installer-build'
    $taskBuildJson = & (Join-Path $PSScriptRoot '..\build-installer.ps1') `
        -BootstrapPath (Join-Path $taskExtract 'cudia.exe') `
        -LauncherPath (Join-Path $taskExtract 'launcher.exe') `
        -ManifestPath (Join-Path $taskExtract 'installation-preview.json') `
        -ArchivePath (Join-Path $taskExtract $taskArchiveName) `
        -Channel preview -Variant $Variant -OutputDirectory $taskBuildOut -CompilerPath $taskIscc
    if ($LASTEXITCODE -ne 0) { throw 'Installer build script failed.' }
    $taskBuild = ($taskBuildJson -join "`n") | ConvertFrom-Json
    if ($taskBuild.completed -ne $true -or $taskBuild.compiled -ne $true -or $taskBuild.developerArtifact -ne $false -or
        $taskBuild.channel -cne 'preview' -or $taskBuild.variant -cne $Variant -or
        [long]$taskBuild.sequence -ne [long]$taskCandidate.sequence -or $taskBuild.version -cne $taskCandidate.version) {
        throw 'Installer build receipt does not match candidate identity.'
    }
    $taskGenerated = [string]$taskBuild.installer.path
    if (-not (Test-Path -LiteralPath $taskGenerated -PathType Leaf)) { throw 'Build receipt installer file is missing.' }
    Copy-Item -LiteralPath $taskGenerated -Destination $taskSetup -ErrorAction Stop
    if ((Get-FileSha256 $taskSetup) -cne $taskBuild.installer.sha256 -or (Get-Item -LiteralPath $taskSetup).Length -ne [long]$taskBuild.installer.size) { throw 'Copied installer differs from build receipt.' }

    $taskBuild | Add-Member -MemberType NoteProperty -Name defenderScan -Value 'unavailable'
    $taskMpScan = Get-Command Start-MpScan -ErrorAction SilentlyContinue
    $taskDefenderService = Get-Service -Name WinDefend -ErrorAction SilentlyContinue
    if ($taskMpScan -and $taskDefenderService -and $taskDefenderService.Status -eq 'Running') {
        Start-MpScan -ScanType CustomScan -ScanPath $taskSetup
        $taskThreats = @(Get-MpThreatDetection -ErrorAction Stop | Where-Object {
            @($_.Resources) -match [regex]::Escape($taskSetup)
        })
        if ($taskThreats.Count -gt 0) { throw 'Microsoft Defender reported a threat in the installer output.' }
        $taskBuild.defenderScan = 'passed'
    }

    $taskBuild.installer.path = [IO.Path]::GetFileName($taskSetup)
    $taskBuild | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $taskReportPath -Encoding UTF8
    $taskUploadPath = $taskSetup

    # Expose the scoped job token only to the single GitHub CLI upload process.
    $env:GH_TOKEN = $taskUploadToken
    try {
        & gh release upload ([string]$taskCandidate.tag) $taskUploadPath --repo 'victorccronemberger-blip/cudia'
        if ($LASTEXITCODE -ne 0) { throw 'GitHub release asset upload failed.' }
        & gh release upload ([string]$taskCandidate.tag) $taskReportPath --repo 'victorccronemberger-blip/cudia'
        if ($LASTEXITCODE -ne 0) { throw 'Build receipt upload failed.' }
    } finally { [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process') }
    Get-Content -LiteralPath $taskReportPath -Raw
} finally {
    [Environment]::SetEnvironmentVariable('CUDIA_CI_GITHUB_TOKEN', $null, 'Process')
    [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process')
    $taskUploadToken = $null
    $taskTempFull = [IO.Path]::GetFullPath($taskTemp)
    $taskRunnerTempFull = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    if ($taskTempFull.StartsWith($taskRunnerTempFull, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $taskTempFull) -match '^cudia-installer-inputs-[a-f0-9]{32}$' -and
        (Test-Path -LiteralPath $taskTempFull -PathType Container) -and
        -not ((Get-Item -LiteralPath $taskTempFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        # Never recursively remove a tree containing an alias to another path.
        $taskQueue = New-Object 'System.Collections.Generic.Queue[string]'
        $taskQueue.Enqueue($taskTempFull)
        $taskHasReparse = $false
        while ($taskQueue.Count -gt 0 -and -not $taskHasReparse) {
            foreach ($taskItem in (Get-ChildItem -LiteralPath $taskQueue.Dequeue() -Force)) {
                if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { $taskHasReparse = $true; break }
                if ($taskItem.PSIsContainer) { $taskQueue.Enqueue($taskItem.FullName) }
            }
        }
        if (-not $taskHasReparse -and [IO.Path]::GetFullPath($taskTemp).StartsWith($taskRunnerTempFull, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf ([IO.Path]::GetFullPath($taskTemp))) -match '^cudia-installer-inputs-[a-f0-9]{32}$' -and
            (Test-Path -LiteralPath $taskTempFull -PathType Container) -and
            -not ((Get-Item -LiteralPath $taskTempFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $taskTempFull -Recurse -Force
        }
    }
}
