$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$bridgeRuntimeFile = [IO.Path]::GetFullPath((Join-Path $bridgeRoot 'work\audio-control-bridge\bandlab-runtime.json'))
if ($env:AUDIO_BRIDGE_RUNTIME) {
    if ($env:AUDIO_BRIDGE_RUNTIME -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
        throw 'AUDIO_BRIDGE_RUNTIME must be an absolute path to the pairing JSON file.'
    }
    $bridgeRuntimeFile = [IO.Path]::GetFullPath($env:AUDIO_BRIDGE_RUNTIME)
}
if (-not (Test-Path -LiteralPath $bridgeRuntimeFile)) { Write-Host 'No bridge runtime file exists.'; return }
$bridgeConfig = Get-Content -LiteralPath $bridgeRuntimeFile -Raw | ConvertFrom-Json
$bridgePid = [int]$bridgeConfig.pid
$bridgeServerFile = [IO.Path]::GetFullPath((Join-Path $bridgeRoot 'src\bandlab-server.mjs'))
$bridgeProcessInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $bridgePid) -ErrorAction Stop
if (-not $bridgeProcessInfo) { Write-Host 'The bridge is already stopped.'; return }
if ($bridgeProcessInfo.Name -ne 'node.exe' -or -not $bridgeProcessInfo.CommandLine.Contains($bridgeServerFile)) {
    throw 'Saved process does not match this bridge. No process was stopped.'
}
Stop-Process -Id $bridgePid -ErrorAction Stop
Write-Host 'BandLab bridge stopped. Restarting creates a new pairing token.'
