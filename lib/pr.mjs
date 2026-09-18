// What the pull request for a session's branch is doing: checks, reviews, auto-merge.
//
// Everything comes from the `gh` CLI that is already signed in on this machine. We
// hold no token and make no network call of our own; if gh is missing or signed out,
// the bar simply says so instead of pretending there is no pull request.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup,comments,reviews,headRefName,updatedAt';

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

// gh reports a check run as `conclusion` and a commit status as `state`, and a run
// that has not finished has neither.
const outcome = (c) => String(c.conclusion || c.state || '').toUpperCase();

function shape(j) {
  const rollup = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
  const failed = rollup.filter((c) => FAILED.includes(outcome(c)));
  const passed = rollup.filter((c) => PASSED.includes(outcome(c)));
  const pending = rollup.filter((c) => !FAILED.includes(outcome(c)) && !PASSED.includes(outcome(c)));
  const said = [
    ...(j.reviews || []).filter((r) => (r.body || '').trim() || r.state === 'CHANGES_REQUESTED'),
    ...(j.comments || []),
  ]
    .map((r) => ({
      author: r.author?.login || '',
      body: String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      state: r.state || '',
      at: r.submittedAt || r.createdAt || '',
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    has: true,
    number: j.number,
    title: j.title,
    url: j.url,
    state: j.state,
    draft: !!j.isDraft,
    branch: j.headRefName,
    mergeable: j.mergeable,
    mergeState: j.mergeStateStatus,
    review: j.reviewDecision || '',
    autoMerge: !!j.autoMergeRequest,
    checks: {
      total: rollup.length,
      passed: passed.length,
      failed: failed.length,
      pending: pending.length,
      failing: failed.slice(0, 6).map((c) => ({ name: c.name || c.context || 'check', url: c.detailsUrl || c.targetUrl || '' })),
    },
    comments: said.slice(0, 8),
    commentCount: said.length,
  };
}

/** Read the pull request for whatever branch is checked out in `cwd`. */
export async function read(cwd) {
  let out;
  try {
    out = await execFileP('gh', ['pr', 'view', '--json', FIELDS], { cwd, timeout: 20000, windowsHide: true });
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (e.code === 'ENOENT' || /is not recognized|command not found/i.test(msg)) return { has: false, noCli: true };
    if (/gh auth login|authentication|not logged in/i.test(msg)) return { has: false, needsAuth: true };
    if (/no pull requests found|no default remote|not a git repository|could not determine/i.test(msg)) return { has: false };
    return { has: false, error: msg.trim().split('\n').filter(Boolean)[0] || 'gh refused' };
  }
  try { return shape(JSON.parse(out.stdout)); } catch { return { has: false }; }
}

/** Turn GitHub's own auto-merge on or off for that pull request. */
export async function setAutoMerge(cwd, on, method = 'squash') {
  const how = ['merge', 'squash', 'rebase'].includes(method) ? method : 'squash';
  const args = on ? ['pr', 'merge', '--auto', '--' + how] : ['pr', 'merge', '--disable-auto'];
  await execFileP('gh', args, { cwd, timeout: 30000, windowsHide: true });
}

// One reading per folder per minute is plenty: the bar polls while a session is open
// and several devices can be watching the same one.
const cache = new Map();
const TTL = 45000;
export async function cached(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await read(cwd);
  cache.set(cwd, { at: Date.now(), value });
  return value;
}
export const forget = (cwd) => cache.delete(cwd);
