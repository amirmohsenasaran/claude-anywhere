// Put a Node binary in runtime/, where the installer picks it up (bundle.resources).
//
// The app's server is a Node program, and asking people to install Node first was the
// one step of setup the app could not do for them: the window came up and said "Install
// Node 20 or newer". So the installer carries its own, and the shell runs that one.
//
//   node scripts/fetch-node.mjs                                  this machine's platform
//   node scripts/fetch-node.mjs --target universal-apple-darwin  both Mac chips in one file
//
// Only the binary is kept - no npm, no headers - and the download is checked against
// nodejs.org's SHASUMS256.txt before anything is unpacked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// An LTS line, pinned so every installer carries the same runtime. The server needs 20+.
const VERSION = '22.23.1';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'runtime');
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : '';
const universal = target === 'universal-apple-darwin';

const plat = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform];
if (!plat) throw new Error('No Node build for ' + process.platform);
const arches = universal ? ['arm64', 'x64'] : [process.arch];
const bin = plat === 'win' ? 'node.exe' : 'node';

const base = `https://nodejs.org/dist/v${VERSION}/`;
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' answered ' + r.status); return Buffer.from(await r.arrayBuffer()); };
const sums = (await get(base + 'SHASUMS256.txt')).toString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-'));
const pieces = [];
for (const arch of arches) {
  const name = `node-v${VERSION}-${plat}-${arch}`;
  const file = name + (plat === 'win' ? '.zip' : '.tar.gz');
  const want = sums.split('\n').find((l) => l.endsWith('  ' + file))?.split(' ')[0];
  if (!want) throw new Error(file + ' is not in SHASUMS256.txt');
  const data = await get(base + file);
  const got = crypto.createHash('sha256').update(data).digest('hex');
  if (got !== want) throw new Error(`${file}: sha256 ${got}, expected ${want}`);
  const archive = path.join(tmp, file);
  fs.writeFileSync(archive, data);
  // Windows' own tar is bsdtar, which reads zip; a GNU tar earlier on PATH (Git's) does not.
  const inside = plat === 'win' ? `${name}/${bin}` : `${name}/bin/${bin}`;
  const tar = plat === 'win' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', tmp, inside], { stdio: 'inherit' });
  pieces.push(path.join(tmp, inside));
  console.log(`node ${VERSION} ${plat}-${arch}: ${(data.length / 1048576).toFixed(1)} MB, sha256 ok`);
}

fs.mkdirSync(out, { recursive: true });
const dest = path.join(out, bin);
fs.rmSync(dest, { force: true });
if (universal) {
  execFileSync('lipo', ['-create', ...pieces, '-output', dest], { stdio: 'inherit' });
  // lipo drops the Node project's signature, and Apple silicon will not run an unsigned
  // binary at all - an ad-hoc signature is enough for it to start.
  execFileSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'inherit' });
} else {
  fs.copyFileSync(pieces[0], dest);
}
fs.chmodSync(dest, 0o755);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`runtime/${bin}: ${execFileSync(dest, ['--version']).toString().trim()}, ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`);
