// Print the changelog section for one version, for a release's notes.
//
//   node scripts/release-notes.mjs v0.4.0 > RELEASE_NOTES.md
//
// The release workflow feeds this to the GitHub release, so what people read on
// the release page is what is in CHANGELOG.md rather than a link to it.

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

if (!body) {
  process.stderr.write(`no changelog section for ${version}\n`);
  body = 'See [CHANGELOG.md](../blob/main/CHANGELOG.md) for what changed.';
}
process.stdout.write(body + '\n');
