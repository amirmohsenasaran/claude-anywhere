// What the next release is, and whether there should be one at all. The Release
// workflow asks this and decides nothing by itself.
//
//   node scripts/next-version.mjs          # decide from the tags and the changelog
//   node scripts/next-version.mjs 0.5.0    # force a number (still refuses a used one)
//
// Prints `key=value` lines for $GITHUB_OUTPUT on stdout and the reasoning on
// stderr, so the run's log says why it did or did not cut a release.
//
// The rules, in one place so they are arguable:
//   - a merge that only touched docs, the changelog or the workflows is not a release;
//   - `[skip release]` in the merged commit's subject line is not a release;
//   - an Unreleased section with an `### Added` block is a minor bump, anything
//     else is a patch — while the major is 0 that is the promise the changelog makes;
//   - a package.json already ahead of the last tag is taken at its word, which is
//     the way to release 1.0.0 without editing this file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const say = (m) => process.stderr.write(m + '\n');
const out = {};

const parse = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
const cmp = (a, b) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const bump = (v, kind) => { const [ma, mi, pa] = parse(v); return kind === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`; };

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean).sort(cmp);
const last = tags[tags.length - 1] || '';
say(`last tag: ${last || '(none yet)'} · package.json: ${pkg.version}`);

// Only what ships counts. A release whose whole diff is README wording is noise on
// the download page and a pointless three-platform build.
const SHIPPED = /^(server\.mjs|package(-lock)?\.json|lib\/|public\/|scripts\/|src-tauri\/)/;
const changed = last ? git('diff', '--name-only', `${last}..HEAD`).split('\n').filter(Boolean) : ['(first release)'];
const shipped = last ? changed.filter((f) => SHIPPED.test(f)) : changed;
// The subject only: a body that merely explains what [skip release] does — like the
// commit that introduced it — must not cancel its own release.
const subject = git('log', '-1', '--format=%s');

const forced = process.argv[2] ? String(process.argv[2]).replace(/^v/, '') : '';
if (forced && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(forced)) { say(`${forced} is not a version like 0.5.0`); process.exit(1); }

// The changelog is the source of the notes, so it is also the source of the bump.
const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const section = (md.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/) || [])[1] || '';
const entries = section.split('\n').filter((l) => l.startsWith('- ')).length;
const added = /###\s+Added\s*\n+\s*-\s/.test(section);
say(`unreleased: ${entries} entr${entries === 1 ? 'y' : 'ies'}${added ? ', with an Added section' : ''}`);
say(`changed since ${last || 'the beginning'}: ${changed.length} file(s), ${shipped.length} of them shipped`);

let reason = '';
if (/\[skip release\]/i.test(subject)) reason = 'the merged commit subject says [skip release]';
else if (last && !shipped.length) reason = 'nothing that ships changed — docs, workflows or the changelog only';

const kind = added ? 'minor' : 'patch';
const version = forced || (cmp(pkg.version, last || '0.0.0') > 0 ? pkg.version : bump(last || '0.0.0', kind));
if (!reason && tags.includes(`v${version}`)) reason = `v${version} is already tagged`;

out.release = reason ? 'false' : 'true';
out.version = version;
out.tag = `v${version}`;
out.bump = forced ? 'forced' : cmp(pkg.version, last || '0.0.0') > 0 ? 'package.json' : kind;
out.notes = entries ? 'changelog' : 'commits';
out.reason = reason || `${out.bump} bump from ${last || 'nothing'}`;

say(reason ? `no release: ${reason}` : `releasing ${version} (${out.bump}, notes from the ${out.notes})`);
process.stdout.write(Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
