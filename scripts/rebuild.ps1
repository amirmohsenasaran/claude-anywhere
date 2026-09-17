# Rebuild the desktop app and relaunch it, waiting first until Claude is not mid-turn.
# Started detached by the server (POST /api/rebuild) so it survives the app restart.
param([string]$Repo = "C:\Users\arya\Desktop\claude-remote", [int]$Port = 7777, [string]$Token = "", [string]$Log = "")
$ErrorActionPreference = "Continue"
if (-not $Log) { $Log = Join-Path $env:TEMP "claude-remote-rebuild.log" }
function Say($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -Path $Log -Value $line -Encoding utf8 }
Set-Content -Path $Log -Value "" -Encoding utf8
Say "rebuild requested"
$headers = @{ Authorization = "Bearer $Token" }
$waited = 0
while ($true) {
  try { $runs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Headers $headers -TimeoutSec 5 } catch { $runs = @() }
  if (-not $runs -or $runs.Count -eq 0) { break }
  if ($waited -eq 0) { Say "waiting: Claude is still working ($($runs.Count) turn(s))" }
  if ($waited -ge 1800) { Say "gave up after 30 min: still busy"; exit 2 }
  Start-Sleep -Seconds 15; $waited += 15
}
Say "no running turns; stopping the app"
Stop-Process -Name claude-remote -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Say "building (cargo tauri build) - this takes 1-3 minutes"
Push-Location (Join-Path $Repo "src-tauri")
$out = & cargo tauri build 2>&1
$rc = $LASTEXITCODE
Pop-Location
$out | Select-Object -Last 8 | ForEach-Object { Say "  $_" }
if ($rc -ne 0) { Say "build FAILED (exit $rc); relaunching the previous build" } else { Say "build ok" }
$exe = Join-Path $Repo "src-tauri\target\release\claude-remote.exe"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
Start-Sleep -Seconds 8
$up = Get-Process claude-remote -ErrorAction SilentlyContinue
Say ("app relaunched: " + [bool]$up)
Say "done"
