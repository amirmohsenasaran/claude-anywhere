# Rebuild the desktop app and relaunch it. Started by the server
# (POST /api/rebuild); it outlives the window it closes.
#
# The window has to go away while it builds: the running app holds files in
# target/release, and cargo fails with "used by another process" even if the
# exe itself is renamed aside. The chat does not stop, though - the server is
# a separate process that stays up on its own while a turn is running, so the
# phone, the browser and the turn in flight all keep going, and this log can be
# read from any of them at /api/rebuild/log.
#
# It never waits for Claude to be idle first: whoever presses Rebuild is usually
# talking to Claude through this very app, so "wait until nothing is running"
# waited for itself and looked stuck.
param([string]$Repo = "C:\Users\arya\Desktop\claude-remote", [int]$Port = 7777, [string]$Token = "", [string]$Log = "")
$ErrorActionPreference = "Continue"
if (-not $Log) { $Log = Join-Path $env:TEMP "claude-remote-rebuild.log" }
function Say($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -Path $Log -Value $line -Encoding utf8 }
Set-Content -Path $Log -Value "" -Encoding utf8
$headers = @{ Authorization = "Bearer $Token" }
$exeDir = Join-Path $Repo "src-tauri\target\release"
$exe = Join-Path $exeDir "claude-remote.exe"

Say "rebuild requested"
$live = 0
try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Headers $headers -TimeoutSec 5; if ($r) { $live = @($r).Count } } catch {}
if ($live -gt 0) { Say "Claude is working - the chat carries on while the window is away" }

Say "closing the window (the server stays up)"
Get-Process claude-remote -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$exeDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Say "compiling - about 1 to 3 minutes"
$outFile = Join-Path $env:TEMP "claude-remote-build.out"
$errFile = Join-Path $env:TEMP "claude-remote-build.err"
$p = Start-Process -FilePath "cargo" -ArgumentList "tauri", "build" -WorkingDirectory (Join-Path $Repo "src-tauri") -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$sec = 0
while (-not $p.HasExited) {
  Start-Sleep -Seconds 5; $sec += 5
  if ($sec % 30 -eq 0) { Say "still compiling ($sec s)" }
  if ($sec -ge 900) { Say "giving up: the build passed 15 minutes"; try { $p.Kill() } catch {}; break }
}
$rc = if ($p.HasExited) { $p.ExitCode } else { 1 }
if ($rc -ne 0) { Get-Content $errFile -ErrorAction SilentlyContinue | Select-Object -Last 8 | ForEach-Object { if ($_ -and $_.Trim()) { Say "  $_" } } }
if ($rc -ne 0) { Say "build FAILED (exit $rc) - bringing back the version you had" } else { Say "build ok ($sec s)" }

Say "starting the app"
Start-Process -FilePath $exe -WorkingDirectory $exeDir
Start-Sleep -Seconds 8
$up = Get-Process claude-remote -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
Say ("app is back: " + [bool]$up)
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -Headers $headers -TimeoutSec 5
  if ($v.stale) { Say "the server is still running older code - use Restart server when Claude is idle" }
} catch {}
Say "done"
