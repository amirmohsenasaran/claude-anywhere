# Rebuild the desktop app and relaunch it. Started detached by the server
# (POST /api/rebuild) so it survives the app restart.
#
# The build runs FIRST, while the app keeps running: Windows lets a running .exe
# be renamed, so the old one is moved aside and cargo links the new one in its
# place. Only the swap at the end needs the app to be idle, and that takes
# seconds instead of the minutes the compile takes. Waiting for idle *before*
# building was the old behaviour, and it hung forever whenever the person was
# talking to Claude through this very app.
param([string]$Repo = "C:\Users\arya\Desktop\claude-remote", [int]$Port = 7777, [string]$Token = "", [string]$Log = "")
$ErrorActionPreference = "Continue"
if (-not $Log) { $Log = Join-Path $env:TEMP "claude-remote-rebuild.log" }
function Say($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -Path $Log -Value $line -Encoding utf8 }
Set-Content -Path $Log -Value "" -Encoding utf8
$headers = @{ Authorization = "Bearer $Token" }
function LiveRuns { try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Headers $headers -TimeoutSec 5; if ($r) { return @($r).Count } else { return 0 } } catch { return 0 } }

$exeDir = Join-Path $Repo "src-tauri\target\release"
$exe = Join-Path $exeDir "claude-remote.exe"
Say "rebuild requested - the app keeps running while it compiles"

# Move the running binary aside so the linker can write a new one next to it.
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$old = Join-Path $exeDir "claude-remote.old-$stamp.exe"
$moved = $false
if (Test-Path $exe) {
  try { Rename-Item -Path $exe -NewName (Split-Path $old -Leaf) -ErrorAction Stop; $moved = $true; Say "current build set aside" }
  catch { Say "could not set the current build aside: $($_.Exception.Message)" }
}

Say "compiling (1-3 minutes)"
$outFile = Join-Path $env:TEMP "claude-remote-build.out"
$errFile = Join-Path $env:TEMP "claude-remote-build.err"
$p = Start-Process -FilePath "cargo" -ArgumentList "tauri", "build" -WorkingDirectory (Join-Path $Repo "src-tauri") -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$sec = 0
while (-not $p.HasExited) {
  Start-Sleep -Seconds 10; $sec += 10
  if ($sec % 30 -eq 0) { Say "still compiling ($sec s)" }
  if ($sec -ge 900) { Say "giving up: the build took over 15 minutes"; try { $p.Kill() } catch {} ; break }
}
$rc = $p.ExitCode
Get-Content $errFile -ErrorAction SilentlyContinue | Select-Object -Last 6 | ForEach-Object { if ($_ -and $_.Trim()) { Say "  $_" } }

if ($rc -ne 0 -or -not (Test-Path $exe)) {
  Say "build FAILED (exit $rc) - keeping the version you are running"
  if ($moved -and -not (Test-Path $exe)) { try { Rename-Item -Path $old -NewName (Split-Path $exe -Leaf) } catch {} }
  Say "done"
  exit 1
}
Say "build ok"

# The swap: a few seconds of no window. Wait for the current turn to end first.
$waited = 0
while ((LiveRuns) -gt 0) {
  if ($waited -eq 0) { Say "ready - restarting as soon as Claude finishes the current turn" }
  if ($waited -ge 3600) { Say "still busy after an hour; restarting anyway"; break }
  Start-Sleep -Seconds 5; $waited += 5
}
$idle = (LiveRuns) -eq 0
Say "restarting the app"
Get-Process claude-remote -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -or $_.Path -eq $old } | Stop-Process -Force -ErrorAction SilentlyContinue
# Nothing is running, so let the server go too: the new app starts a fresh one
# with the latest server code. While a turn is live the server stays up and the
# new app adopts it, and the update banner offers "Restart server" later.
if ($idle) { Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }
Start-Sleep -Seconds 2
Start-Process -FilePath $exe -WorkingDirectory $exeDir
Start-Sleep -Seconds 8
$up = Get-Process claude-remote -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
Say ("app relaunched: " + [bool]$up)
Get-ChildItem -Path $exeDir -Filter "claude-remote.old-*.exe" -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {} }
Say "done"
