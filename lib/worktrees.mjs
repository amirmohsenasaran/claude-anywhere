// Per-session git worktrees. A worktree is a second checkout of the same repository
// on its own branch, so a session can work on something without disturbing what is
// open in the editor on the main checkout.
//
// Ours go *beside* the repository, never inside it: a worktree within the tree
// confuses every tool that walks the project, starting with git itself.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const gitOut = (cwd, args, timeout = 15000) =>
  execFileP('git', ['-C', cwd, ...args], { timeout, windowsHide: true }).then((r) => r.stdout.trim());

/** The last line git or gh printed, which is the part that says what went wrong. */
export const cliError = (e) => String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] || 'the command refused';

export const sameDir = (a, b) =>
  path.normalize(String(a || '')).replace(/[\\/]+$/, '').toLowerCase() === path.normalize(String(b || '')).replace(/[\\/]+$/, '').toLowerCase();

/** Where a worktree for `branch` of the repository at `root` belongs. */
export const worktreePath = (root, branch) =>
  path.join(path.dirname(root), path.basename(root) + '-worktrees', branch.replace(/[/]/g, '-'));

/** Every checkout git knows about for this repository, ours marked. */
export async function listFor(cwd, mine = []) {
  const root = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  const out = await gitOut(cwd, ['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: path.normalize(line.slice(9).trim()), branch: '' }; worktrees.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (line.startsWith('detached')) cur.branch = '(detached)';
  }
  return {
    root,
    worktrees: worktrees.map((w) => ({
      ...w,
      main: sameDir(w.path, root),
      ours: mine.some((m) => sameDir(m.path, w.path)),
      gone: !fs.existsSync(w.path),
    })),
  };
}

const VALID_BRANCH = /^[A-Za-z0-9._/-]{1,80}$/;

/**
 * Add a worktree for `branch`. An existing branch is checked out there; a new name is
 * created from the current HEAD. Returns { path, branch, repo, existed }.
 */
export async function add(cwd, branch) {
  const name = String(branch || '').trim();
  if (!VALID_BRANCH.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
    throw Object.assign(new Error('Branch names here can use letters, numbers, dot, dash and slash.'), { status: 400 });
  }
  const root = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  const dir = worktreePath(root, name);
  if (fs.existsSync(dir)) throw Object.assign(new Error('There is already a folder at ' + dir), { status: 409 });
  // `--verify --quiet` exits non-zero for an unknown ref, which is how we tell new from existing.
  const existed = await gitOut(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name]).catch(() => '');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = existed ? ['worktree', 'add', dir, name] : ['worktree', 'add', '-b', name, dir];
  // A first worktree on a big repository copies the whole tree: minutes, not seconds.
  await execFileP('git', ['-C', root, ...args], { timeout: 300000, windowsHide: true });
  return { path: dir, branch: name, repo: root, existed: !!existed };
}

/** Remove a worktree we made. The branch itself stays. */
export async function remove(known, { force = false } = {}) {
  await execFileP('git', ['-C', known.repo, 'worktree', 'remove', ...(force ? ['--force'] : []), known.path], { timeout: 120000, windowsHide: true });
}
