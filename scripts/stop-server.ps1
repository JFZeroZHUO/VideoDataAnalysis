$ErrorActionPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot "data\server.pid"

if (-not (Test-Path -LiteralPath $pidFile)) { exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"

if ($processInfo -and $processInfo.Name -eq "node.exe" -and $processInfo.CommandLine -like "*server/index.mjs*") {
  Stop-Process -Id $serverPid -Force
}

Remove-Item -LiteralPath $pidFile -Force
exit 0
