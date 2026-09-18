// Keep this computer awake while Claude is working.
//
// Every platform has a different way of saying "not now", and all three of them are
// held by a *running process*, not by a call that returns. So we spawn one and keep
// it; letting go is killing it. Nothing is changed in the system's own settings, so a
// crash here cannot leave the machine unable to sleep.
//
//   Windows  SetThreadExecutionState on a thread that stays alive. ES_SYSTEM_REQUIRED
//            without ES_DISPLAY_REQUIRED: the machine stays up, the screen may still
//            turn off, which is what someone running a turn from their phone wants.
//   macOS    caffeinate -s, the same idea with a name.
//   Linux    systemd-inhibit, where it exists.

import { spawn } from 'node:child_process';

// The holder also watches this process. Killing the server the polite way runs the
// exit hook below, but a force-kill does not — and a stray holder nobody can see,
// keeping the machine awake for ever, is the worst way for this to fail.
const ppid = process.pid;

const PS_KEEP_AWAKE = [
  '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
  // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED. The loop is what keeps the thread
  // that made the call alive; ending the process drops the request.
  `Add-Type -Name A -Namespace W -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint e);'; [W.A]::SetThreadExecutionState(0x80000001) | Out-Null; while (Get-Process -Id ${ppid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
];

let child = null;
let lastError = '';
let failedAt = 0;

export const held = () => !!child && child.exitCode === null;

function start() {
  if (held()) return;
  // A machine without systemd-inhibit would otherwise be asked every 30 seconds for
  // as long as the mode is on. Back off, but keep trying, so installing it helps.
  if (lastError && Date.now() - failedAt < 300000) return;
  // `caffeinate -w` waits on a pid and is the same idea, done properly; on Linux the
  // inhibitor holds a shell that watches for us.
  const [cmd, args] = process.platform === 'win32' ? ['powershell.exe', PS_KEEP_AWAKE]
    : process.platform === 'darwin' ? ['caffeinate', ['-s', '-w', String(ppid)]]
    : ['systemd-inhibit', ['--what=idle:sleep', '--who=Claude Anywhere', '--why=Claude is working', '--mode=block',
      'sh', '-c', `while kill -0 ${ppid} 2>/dev/null; do sleep 20; done`]];
  try {
    child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false });
    child.on('error', (e) => { lastError = String(e.message || e); failedAt = Date.now(); child = null; });
    child.on('exit', () => { child = null; });
    lastError = '';
  } catch (e) { lastError = String(e.message || e); failedAt = Date.now(); child = null; }
}

function stop() {
  if (!child) return;
  const c = child; child = null;
  try { c.kill(); } catch {}
}

/**
 * Hold or release according to the mode and whether anything is running.
 * 'working' is the useful one: up while a turn runs, free to sleep the moment it ends.
 */
export function sync(mode, busy) {
  const want = mode === 'always' || (mode === 'working' && busy);
  if (want) start(); else stop();
  return { holding: held(), error: lastError };
}

export const state = (mode) => ({ mode, holding: held(), platform: process.platform, error: lastError });

// A server going down should not leave a stray process holding the machine awake.
// Only 'exit' is hooked: listening for SIGINT or SIGTERM would replace Node's own
// handling of them, and the server would stop answering Ctrl+C.
process.on('exit', () => { try { stop(); } catch {} });
