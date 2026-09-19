// Print the changelog section for one version, for a release's notes.
//
//   node scripts/release-notes.mjs v0.4.0 > RELEASE_NOTES.md
//
// The release workflow feeds this to the GitHub release, so what people read on
// the release page is what is in CHANGELOG.md rather than a link to it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = String(process.argv[2] || '').replace(/^v/, '');
const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const start = md.indexOf(`## [${version}]`);
let body = '';
if (start >= 0) {
  const rest = md.slice(start);
  const next = rest.indexOf('\n## [', 1);
  body = (next > 0 ? rest.slice(0, next) : rest)
    .split('\n').slice(1).join('\n')   // drop the heading itself
    .replace(/^\[.+?\]: http.*$/gm, '') // and the link block, if the section ran into it
    .trim();
}

// A release cut straight off main may have nothing under its own heading — the
// merge simply did not touch the changelog. An empty release page is worse than a
// plain list, so fall back to what the commits since the previous tag say.
if (!body) {
  process.stderr.write(`no changelog section for ${version}; using the commit subjects\n`);
  const git = (...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
  const previous = tags.filter((t) => t !== `v${version}`).sort((a, b) => {
    const p = (v) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
    const [x, y] = [p(a), p(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).pop();
  // The tag may not be pushed yet when this runs; HEAD is the same commit then.
  const head = git('rev-parse', '--verify', `v${version}`) ? `v${version}` : 'HEAD';
  const range = previous ? `${previous}..${head}` : head;
  const lines = git('log', '--no-merges', '--format=%s', range)
    .split('\n')
    .filter((s) => s && !/^release \d/.test(s))
    .map((s) => `- ${s}`);
  body = lines.length ? `### Changed\n\n${lines.join('\n')}` : 'See [CHANGELOG.md](../blob/main/CHANGELOG.md) for what changed.';
}
process.stdout.write(body + '\n');
