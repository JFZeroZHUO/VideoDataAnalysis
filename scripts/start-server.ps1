$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:4318/api/health"
$appUrl = "http://127.0.0.1:4318"
$dataDir = Join-Path $projectRoot "data"
$pidFile = Join-Path $dataDir "server.pid"
$outputLog = Join-Path $dataDir "server-output.log"
$errorLog = Join-Path $dataDir "server-error.log"

function Test-ServerReady {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

if (Test-ServerReady) {
  Start-Process $appUrl
  exit 0
}

$nodeCommand = Get-Command node -ErrorAction Stop
$process = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList "server/index.mjs" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outputLog `
  -RedirectStandardError $errorLog `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 300
  if (Test-ServerReady) {
    Start-Process $appUrl
    exit 0
  }
  if ($process.HasExited) { break }
}

throw "Server did not become ready."
