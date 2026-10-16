# Launch from PowerShell without requiring Git's shell on the caller's PATH.
# run.sh owns configuration, platform selection, and source/build validation.
$ErrorActionPreference = 'Stop'

$gitRoots = @()
$gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($gitCommand) {
    $gitRoots += Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
}
foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base) { $gitRoots += Join-Path $base 'Git' }
}
if ($env:LOCALAPPDATA) {
    $gitRoots += Join-Path $env:LOCALAPPDATA 'Programs\Git'
}
if ($env:USERPROFILE) {
    $gitRoots += Join-Path $env:USERPROFILE 'scoop\apps\git\current'
    $gitRoots += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git'
}

$gitRoot = $null
foreach ($candidate in ($gitRoots | Select-Object -Unique)) {
    if ((Test-Path -LiteralPath (Join-Path $candidate 'cmd\git.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $candidate 'usr\bin\sh.exe') -PathType Leaf)) {
        $gitRoot = $candidate
        break
    }
}
if (-not $gitRoot) {
    throw 'Git for Windows was not found. Install it or add its cmd directory to PATH, then run this script again.'
}

$previousPath = $env:PATH
try {
    $env:PATH = "$(Join-Path $gitRoot 'cmd');$(Join-Path $gitRoot 'usr\bin');$previousPath"
    & (Join-Path $gitRoot 'usr\bin\sh.exe') (Join-Path $PSScriptRoot 'run.sh') @args
    $launchExitCode = $LASTEXITCODE
}
finally {
    $env:PATH = $previousPath
}
exit $launchExitCode
