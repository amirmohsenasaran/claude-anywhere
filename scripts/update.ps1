# Install a downloaded release over this computer's app, and put the window back.
# Started by the server (POST /api/update/install); it outlives the window it closes,
# the same way scripts/rebuild.ps1 does, because the thing it replaces is the app that
# would otherwise be waiting for it.
#
# The download already happened — the server streams it, so progress can be reported —
# and this only has to close, install and reopen.
param([string]$Installer = "", [string]$Exe = "", [string]$Log = "")
$ErrorActionPreference = "Continue"
if (-not $Log) { $Log = Join-Path $env:TEMP "claude-anywhere-update.log" }
function Say($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -Path $Log -Value $line -Encoding utf8 }

if (-not (Test-Path $Installer)) { Say "the installer is not where the server left it: $Installer"; Say "done"; exit 1 }

# Whatever is running from the install folder, not a hard-coded name: the crate can be
# renamed, and the binary is named after it.
$dir = if ($Exe) { Split-Path $Exe -Parent } else { "" }
$running = @()
if ($dir) { $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir*" } }
if ($running) {
  Say "closing the window ($($running.Count) process$(if ($running.Count -ne 1) { 'es' }))"
  foreach ($p in $running) { try { $p.Kill(); [void]$p.WaitForExit(15000) } catch {} }
} else {
  Say "no window open; installing straight away"
}

# The webview processes the app spawned hold files in the install folder for a few
# seconds after it goes, and the installer will not overwrite what is still open.
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'claude-anywhere|Claude Anywhere' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 3

Say "installing $(Split-Path $Installer -Leaf)"
# NSIS: /S is silent. The Tauri installer is per-user, so no elevation prompt appears.
$p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
$code = $p.ExitCode
if ($null -eq $code) { $code = 0 }
if ($code -ne 0) { Say "the installer exited with $code" } else { Say "installed" }

# The installer writes the new binary where the old one was; wait for it rather than
# assuming, because a finished installer is not the same as a finished file copy.
$target = $Exe
if (-not $target -and $dir) { $target = (Get-ChildItem $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*setup*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
$waited = 0
while ($target -and -not (Test-Path $target) -and $waited -lt 20) { Start-Sleep -Seconds 1; $waited++ }

if ($target -and (Test-Path $target)) {
  Say "starting the app"
  Start-Process -FilePath $target -WorkingDirectory (Split-Path $target)
  Start-Sleep -Seconds 6
  $up = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target }
  Say ("app is back: " + [bool]$up)
} else {
  Say "the app is not where it was; open it from the Start menu"
}
try { Remove-Item $Installer -Force -ErrorAction SilentlyContinue } catch {}
Say "done"
