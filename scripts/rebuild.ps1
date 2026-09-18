# Rebuild the desktop app and relaunch it. Started by the server
# (POST /api/rebuild); it outlives the window it closes.
#
# The window has to go away while it builds: the running app holds files under
# target/release, and cargo fails with "used by another process" (os error 32)
# even if the exe itself is renamed aside. The chat does not stop, though - the
# server is a separate process that stays up on its own while a turn is running,
# so the phone, the browser and the turn in flight all keep going, and this log
# can be read from any of them at /api/rebuild/log.
#
# It never waits for Claude to be idle first: whoever presses Rebuild is usually
# talking to Claude through this very app, so "wait until nothing is running"
# waited for itself and looked stuck.
#
# The server passes -Repo; the default is the checkout this script sits in.
param([string]$Repo = "", [int]$Port = 7777, [string]$Token = "", [string]$Log = "")
if (-not $Repo) { $Repo = Split-Path $PSScriptRoot -Parent }
$ErrorActionPreference = "Continue"
if (-not $Log) { $Log = Join-Path $env:TEMP "claude-anywhere-rebuild.log" }
function Say($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -Path $Log -Value $line -Encoding utf8 }
Set-Content -Path $Log -Value "" -Encoding utf8
$headers = @{ Authorization = "Bearer $Token" }
$srcDir = Join-Path $Repo "src-tauri"
$exeDir = Join-Path $srcDir "target\release"
# The binary is named after the crate, and the crate can be renamed, so never
# hard-code it: take the newest .exe that is not an installer.
function Find-Exe {
  Get-ChildItem $exeDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*setup*' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

Say "rebuild requested"
$live = 0
try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runs" -Headers $headers -TimeoutSec 5; if ($r) { $live = @($r).Count } } catch {}
if ($live -gt 0) { Say "Claude is working - the chat carries on while the window is away" }

# What is running now is also the fallback if the build produces nothing.
$app = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$exeDir*" }
$oldExe = if ($app) { @($app)[0].Path } else { (Find-Exe).FullName }

Say "closing the window (the server stays up)"
foreach ($p in @($app)) { try { $p.Kill(); [void]$p.WaitForExit(15000) } catch {} }

# On the GNU toolchain tauri-build copies WebView2Loader.dll into target/release
# on every build, and the running app has that DLL loaded - so does every
# msedgewebview2.exe it spawned, and those outlive their host by a few seconds.
# Overwriting a loaded DLL is "os error 32", reported by tauri-build without a
# path, which is what made this look like a mystery for a whole day. So: wait
# for the file to actually be writable before compiling, and if the webview
# children are the ones still holding it, end them.
$dll = Join-Path $exeDir "WebView2Loader.dll"
function Test-Writable($p) {
  if (-not (Test-Path $p)) { return $true }
  try { $f = [System.IO.File]::Open($p, 'Open', 'Write', 'None'); $f.Close(); return $true } catch { return $false }
}
$waited = 0
while (-not (Test-Writable $dll)) {
  if ($waited -eq 0) { Say "waiting for the WebView2 runtime to let go of WebView2Loader.dll" }
  if ($waited -eq 10) {
    Say "still held after 10s; closing the webview processes this app left behind"
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'claude-anywhere|claude-remote' } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  }
  if ($waited -ge 30) { Say "it is still held; the build will probably fail on it"; break }
  Start-Sleep -Seconds 1; $waited++
}
if ($waited -gt 0 -and (Test-Writable $dll)) { Say "released after ${waited}s" }

function Invoke-Build {
  $outFile = Join-Path $env:TEMP "claude-anywhere-build.out"
  $errFile = Join-Path $env:TEMP "claude-anywhere-build.err"
  $p = Start-Process -FilePath "cargo" -ArgumentList "tauri", "build" -WorkingDirectory $srcDir -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $sec = 0
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 5; $sec += 5
    if ($sec % 30 -eq 0) { Say "still compiling ($sec s)" }
    if ($sec -ge 900) { Say "giving up: the build passed 15 minutes"; try { $p.Kill() } catch {}; break }
  }
  # ExitCode is only filled in once the process has been waited on, and a
  # Start-Process object that is merely "HasExited" can still report nothing -
  # which is how a build that worked was announced as a failure.
  if (-not $p.HasExited) { try { $p.Kill() } catch {} }
  try { $p.WaitForExit(10000) | Out-Null } catch {}
  $err = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { "" }
  $code = $p.ExitCode
  if ($null -eq $code) { $code = if ($err -match 'Built application at|Finished \d+ bundle') { 0 } else { 1 } }
  return @{ code = $code; err = $err; seconds = $sec }
}

Say "compiling - about 1 to 3 minutes"
$build = Invoke-Build
# os error 32 usually means WebView2Loader.dll was still loaded (handled above),
# but a half-written build directory can do it too. Clearing that crate's build
# directory and going again costs one extra compile, only when it happens.
if ($build.code -ne 0 -and $build.err -match "os error 32|used by another process") {
  Say "a file was still locked; clearing the build directory and trying once more"
  Get-ChildItem (Join-Path $exeDir "build") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^(tauri|windows|webview2)' } |
    ForEach-Object { try { Remove-Item -Recurse -Force $_.FullName -ErrorAction Stop } catch {} }
  Start-Sleep -Seconds 2
  $build = Invoke-Build
}
if ($build.code -ne 0) {
  ($build.err -split "`n" | Select-Object -Last 8) | ForEach-Object { if ($_ -and $_.Trim()) { Say "  $($_.Trim())" } }
  Say "build FAILED (exit $($build.code)) - bringing back the version you had"
} else {
  Say "build ok ($($build.seconds) s)"
}

$new = Find-Exe
$exe = if ($new) { $new.FullName } else { $oldExe }
if (-not $exe) { Say "no app to start - build it by hand with: npm run dist"; Say "done"; exit 1 }
Say "starting the app"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
Start-Sleep -Seconds 8
$up = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
Say ("app is back: " + [bool]$up)
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/version" -Headers $headers -TimeoutSec 5
  if ($v.stale) { Say "the server is still running older code - Restart server picks it up" }
} catch {}
Say "done"
