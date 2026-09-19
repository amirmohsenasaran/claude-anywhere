// Cut a release: set the version everywhere, move the changelog's Unreleased
// section under it, commit and tag. Pushing the tag is what starts the build.
//
//   npm run release -- 0.4.0
//   git push && git push origin v0.4.0
//
// The release workflow refuses to build when package.json, tauri.conf.json and
// the tag disagree, so this is the only sanctioned way to change the version.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
const run = (...args) => execFileSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' }).trim();

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || '')) {
  console.error('usage: npm run release -- 1.2.3');
  process.exit(1);
}
if (run('git', 'status', '--porcelain')) {
  console.error('the working tree is dirty; commit or stash first');
  process.exit(1);
}

const edit = (rel, fn) => {
  const p = path.join(root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) { console.error(`${rel}: nothing to change - is it already ${version}?`); process.exit(1); }
  fs.writeFileSync(p, after);
  console.log('  ' + rel);
};

console.log(`version ${version}`);
edit('package.json', (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit('src-tauri/tauri.conf.json', (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));

// Keep a Changelog: today's release takes what is under Unreleased, and the
// link block at the bottom gains a line for it.
const today = new Date().toISOString().slice(0, 10);
edit('CHANGELOG.md', (s) => {
  const repo = 'https://github.com/aryasadeghy/claude-anywhere';
  const previous = (s.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
  return s
    .replace(/## \[Unreleased\]\n/, `## [Unreleased]\n\n## [${version}] — ${today}\n`)
    .replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repo}/compare/v${version}...HEAD`)
    .replace(/^(\[Unreleased\]: .*)$/m, `$1\n[${version}]: ${repo}/${previous ? `compare/v${previous}...v${version}` : `releases/tag/v${version}`}`);
});

// Cargo.lock carries the version too, and a stale one fails `cargo check --locked` in CI.
try {
  run('cargo', 'update', '--manifest-path', 'src-tauri/Cargo.toml', '--package', 'claude-anywhere', '--precise', version);
} catch {
  // Without cargo on the machine cutting the release, the one line it would have
  // changed is this package's own version, so change that line directly.
  const lock = path.join(root, 'src-tauri', 'Cargo.lock');
  const before = fs.readFileSync(lock, 'utf8');
  const after = before.replace(/(name = "claude-anywhere"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
  if (after !== before) { fs.writeFileSync(lock, after); console.log('  src-tauri/Cargo.lock'); }
}

run('git', 'add', '-A');
run('git', 'commit', '-m', `release ${version}`);
run('git', 'tag', '-a', `v${version}`, '-m', `v${version}`);
console.log(`\ntagged v${version}. Review it, then:\n  git push && git push origin v${version}`);
