$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $env:LOCALAPPDATA 'LocalGmapWorker'
$python = Join-Path $data 'python\python.exe'
$session = Join-Path $data 'linkedin_session.json'
$envFile = Join-Path $root 'worker.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*LINKEDIN_PYTHON\s*=\s*(.+)$') { $python = $Matches[1].Trim().Trim('"') }
    if ($line -match '^\s*LINKEDIN_SESSION\s*=\s*(.+)$') { $session = $Matches[1].Trim().Trim('"') }
  }
}
if (-not (Test-Path -LiteralPath $python)) { Write-Host 'Start the worker first to install LinkedIn.'; exit 1 }
Write-Host 'Sign in to LinkedIn in the browser and wait for your feed.'
& $python (Join-Path $PSScriptRoot 'linkedin_login.py') $session
if ($LASTEXITCODE) { Write-Host 'Login failed. Please try again.'; exit 1 }
Write-Host 'LinkedIn session saved. The worker will pick it up shortly.'
