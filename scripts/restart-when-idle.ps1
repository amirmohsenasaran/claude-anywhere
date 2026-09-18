# Ask the running server to restart (pick up new code) as soon as Claude is idle.
# Detached from any terminal so it survives; logs to %TEMP%\claude-anywhere-restart.log.
param([int]$Port = 7777, [string]$Token = "", [int]$MaxMinutes = 120)
$log = Join-Path $env:TEMP "claude-anywhere-restart.log"
function Say($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) -Encoding utf8 }
Set-Content -Path $log -Value "" -Encoding utf8
$headers = @{ Authorization = "Bearer $Token" }
$waited = 0
while ($true) {
  try { $runs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Headers $headers -TimeoutSec 5 } catch { Say "server not answering; giving up"; exit 1 }
  if (-not $runs -or $runs.Count -eq 0) { break }
  if ($waited -eq 0) { Say "waiting: $($runs.Count) turn(s) running" }
  if ($waited -ge ($MaxMinutes * 60)) { Say "gave up after $MaxMinutes min"; exit 2 }
  Start-Sleep -Seconds 10; $waited += 10
}
Say "idle after ${waited}s; requesting restart"
try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/restart" -Method Post -Headers $headers -ContentType "application/json" -Body "{}" -TimeoutSec 5; Say ("restart: " + ($r | ConvertTo-Json -Compress)) } catch { Say "restart failed: $($_.Exception.Message)"; exit 3 }
Start-Sleep -Seconds 8
try { $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -Headers $headers -TimeoutSec 5; Say ("back: commit " + $v.commit + " stale=" + $v.stale + " started=" + $v.serverStartedAt) } catch { Say "not back yet: $($_.Exception.Message)" }
Say "done"
