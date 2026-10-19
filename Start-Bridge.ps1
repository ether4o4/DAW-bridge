$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$bridgeRuntimeFile = [IO.Path]::GetFullPath((Join-Path $bridgeRoot 'work\audio-control-bridge\bandlab-runtime.json'))
if ($env:AUDIO_BRIDGE_RUNTIME) {
    if ($env:AUDIO_BRIDGE_RUNTIME -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
        throw 'AUDIO_BRIDGE_RUNTIME must be an absolute path to the pairing JSON file.'
    }
    $bridgeRuntimeFile = [IO.Path]::GetFullPath($env:AUDIO_BRIDGE_RUNTIME)
}
$bridgeRuntimeDir = Split-Path -Parent $bridgeRuntimeFile
$bridgeNode = (Get-Command node.exe -ErrorAction Stop).Source
$bridgeServerFile = Join-Path $bridgeRoot 'src\bandlab-server.mjs'
function Get-BridgeStatus {
    if (Test-Path -LiteralPath $bridgeRuntimeFile) {
        try {
            $bridgeConfig = Get-Content -LiteralPath $bridgeRuntimeFile -Raw | ConvertFrom-Json
            if ($bridgeConfig.port -eq 17845 -and $bridgeConfig.token -match '^[a-f0-9]{64}$') {
                return Invoke-RestMethod -Uri 'http://127.0.0.1:17845/v1/status' -Headers @{Authorization=('Bearer ' + $bridgeConfig.token)} -TimeoutSec 2
            }
        } catch { return $null }
    }
    return $null
}
if (Get-BridgeStatus) { Write-Host 'BandLab bridge is already running on this PC.'; return }
New-Item -ItemType Directory -Path $bridgeRuntimeDir -Force | Out-Null
$bridgeProcess = Start-Process -FilePath $bridgeNode -ArgumentList ('"' + $bridgeServerFile + '"') -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeRuntimeDir 'server.log') -RedirectStandardError (Join-Path $bridgeRuntimeDir 'server-error.log')
for ($bridgeAttempt = 0; $bridgeAttempt -lt 20; $bridgeAttempt++) {
    Start-Sleep -Milliseconds 150
    if (Get-BridgeStatus) {
        Write-Host 'BandLab bridge started on 127.0.0.1:17845.'
        Write-Host ('Pairing file: ' + $bridgeRuntimeFile)
        Write-Host 'In the extension popup, select this JSON file and connect the current Studio tab.'
        return
    }
    $bridgeProcess.Refresh()
    if ($bridgeProcess.HasExited) { throw ('Bridge stopped during startup. See ' + (Join-Path $bridgeRuntimeDir 'server-error.log')) }
}
throw ('Bridge did not respond. See logs in ' + $bridgeRuntimeDir)
