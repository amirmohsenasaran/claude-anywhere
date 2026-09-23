#!/usr/bin/env node
// The phone app: set it up, run it, build it.
//
//   npm run mobile -- init  android|ios     generate the Android Studio / Xcode project
//   npm run mobile -- dev   android|ios     run it on a plugged-in phone or a simulator
//   npm run mobile -- build android|ios     an .apk to install, or the iOS app to sign
//   npm run mobile -- open  android|ios     open the generated project in its IDE
//
// The generated projects live in src-tauri/gen/, which is not committed: they are made
// from tauri.conf.json by tauri-cli, and the one thing we change in them is re-applied
// here every time, so a fresh clone and a CI runner end up with the same app.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, platform, ...rest] = process.argv.slice(2);
const PLATFORMS = ['android', 'ios'];
const say = (s) => console.log('[mobile] ' + s);
const die = (s) => { console.error('[mobile] ' + s); process.exit(1); };

if (!['init', 'dev', 'build', 'open'].includes(cmd) || !PLATFORMS.includes(platform)) {
  die('usage: npm run mobile -- <init|dev|build|open> <android|ios> [tauri args…]');
}
if (platform === 'ios' && process.platform !== 'darwin') die('iOS builds need a Mac with Xcode.');

// `cargo tauri` when it is installed (it is, for anyone who builds the desktop app);
// otherwise the npm build of the same CLI, fetched for this run and not added to the
// project's dependencies.
function tauri(args) {
  const hasCargoTauri = spawnSync('cargo', ['tauri', '--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
  const [bin, pre] = hasCargoTauri ? ['cargo', ['tauri']] : ['npx', ['-y', '@tauri-apps/cli@^2']];
  say([bin, ...pre, ...args].join(' '));
  const r = spawnSync(bin, [...pre, ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status || 1);
}

const genDir = path.join(root, 'src-tauri', 'gen', platform === 'ios' ? 'apple' : 'android');

// Android's template allows plain http only in debug builds. The phone talks to your
// computer at http://<its address>:7777 over your own Wi-Fi or Tailscale, so a release
// build with cleartext off opens to a white screen and says nothing about why.
function patchAndroid() {
  const gradle = path.join(genDir, 'app', 'build.gradle.kts');
  if (!fs.existsSync(gradle)) die('expected ' + gradle + ' after init — has the template moved?');
  const src = fs.readFileSync(gradle, 'utf8');
  const off = /(defaultConfig\s*\{[^}]*?manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*)"false"/s;
  if (off.test(src)) {
    fs.writeFileSync(gradle, src.replace(off, '$1"true"'));
    say('release builds may reach a computer over http (usesCleartextTraffic = true)');
  } else if (/defaultConfig\s*\{[^}]*?usesCleartextTraffic"\]\s*=\s*"true"/s.test(src)) {
    say('cleartext already allowed');
  } else {
    die('could not find usesCleartextTraffic in ' + gradle + ' — check the Android template.');
  }
}

function init() {
  const args = [platform, 'init'];
  if (process.env.CI) args.push('--ci');
  tauri(args);
  if (platform === 'android') patchAndroid();
  // iOS needs nothing patched: tauri-cli merges src-tauri/Info.plist (the http exception
  // the Mac app already has) and Info.ios.plist (the local-network sentence) at build.
  if (platform === 'ios' && !process.env.APPLE_DEVELOPMENT_TEAM) {
    say('to run on your own iPhone, set APPLE_DEVELOPMENT_TEAM to your team id first (see docs/mobile.md)');
  }
}

if (cmd === 'init') {
  init();
} else {
  if (!fs.existsSync(genDir)) { say('no ' + path.relative(root, genDir) + ' yet — generating it first'); init(); }
  else if (platform === 'android') patchAndroid(); // a project made before this script existed
  if (cmd === 'open') tauri([platform, 'open']);
  if (cmd === 'dev') tauri([platform, 'dev', ...rest]);
  if (cmd === 'build') {
    tauri([platform, 'build', ...(platform === 'android' && !rest.includes('--aab') ? ['--apk'] : []), ...rest]);
    const out = platform === 'android'
      ? path.join(genDir, 'app', 'build', 'outputs', 'apk')
      : path.join(genDir, 'build');
    say('built — look in ' + path.relative(root, out));
  }
}
