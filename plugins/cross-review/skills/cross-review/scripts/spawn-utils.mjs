// Shared win32-safe process spawning and tree-killing, extracted from
// codex-dispatch.mjs and opencode-dispatch.mjs (pure extraction, no behavior
// change -- both dispatchers' own test suites pass unchanged against this
// module). Used by both dispatchers and by preflight.mjs for its own
// --exec-spawned child.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// pid -> { ppid, pgid } for every process: from /proc on Linux (no procps needed), from ps elsewhere, null when
// neither can be read. Fields 4 and 5 of /proc/<pid>/stat, counted after the last ")" since the name may hold one.
export function processTable({ platform = process.platform } = {}) {
  if (platform === 'win32') return null;
  if (platform === 'linux') {
    try {
      const table = new Map();
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let text;
        try { text = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
        table.set(Number(name), { ppid: Number(fields[1]), pgid: Number(fields[2]) });
      }
      return table;
    } catch { /* no /proc: try ps */ }
  }
  const res = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 20000 });
  if (res.status !== 0) return null;
  const table = new Map();
  for (const line of (res.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return table;
}

// The process groups a seat process tree leads: groups whose leader is the process or one of its descendants. A CLI
// runs its tool commands in groups of their own, which a signal to its own group does not reach. A group shared
// with a process outside the tree is left alone, and a descendant already moved to another parent cannot be found.
export function treeGroups(pid, table) {
  const tree = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, info] of table) if (!tree.has(p) && tree.has(info.ppid)) { tree.add(p); grew = true; }
  }
  const groups = new Set();
  for (const p of tree) { const g = table.get(p)?.pgid; if (g !== undefined && tree.has(g)) groups.add(g); }
  return [...groups];
}

const realKill = (pid, sig) => process.kill(pid, sig);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// A second call writing the same --final-message-out would replace a seat's finished answer (one run
// started a duplicate resume that way). An earlier result.json is kept by preserveEarlierResult, and a
// redaction resume in the same folder is legitimate, so only the answer file is guarded.
export async function completedRunRefusal(finalMessageOut) {
  if (finalMessageOut && (await exists(path.resolve(finalMessageOut)))) {
    const { size } = await fs.stat(path.resolve(finalMessageOut));
    const content = size === 0 ? 'it is empty (0 bytes), so that answer failed' : `${size} bytes`;
    return `--final-message-out ${path.resolve(finalMessageOut)} already exists, so a seat already answered into it (${content}); check it, and pass --replace-completed only to overwrite it on purpose`;
  }
  return null;
}

// A dispatcher retry in the same folder must not overwrite the failed attempt's evidence: rename
// result.json (and its result.stderr.log, if any) to the first free result.attempt-<n>.* name.
// Returns the new result path, or null when there was nothing to keep.
export async function preserveEarlierResult(resultPath) {
  if (!(await exists(resultPath))) return null;
  const dir = path.dirname(resultPath);
  const stderrLog = path.join(dir, 'result.stderr.log');
  for (let n = 1; ; n++) {
    const target = path.join(dir, `result.attempt-${n}.json`);
    if (await exists(target)) continue;
    await fs.rename(resultPath, target);
    if (await exists(stderrLog)) await fs.rename(stderrLog, path.join(dir, `result.attempt-${n}.stderr.log`));
    // A worker that died never wrote the final stderr log; its live log is then the only record of the attempt.
    const liveLog = path.join(dir, 'result.stderr.live.log');
    if (await exists(liveLog)) await fs.rename(liveLog, path.join(dir, `result.attempt-${n}.stderr.live.log`));
    return target;
  }
}

// --final-message-out: the seat's final message as UTF-8 without BOM, via temp file + rename,
// so an orchestrator never re-saves it through a shell that re-encodes it.
export async function writeFinalMessage(filePath, text) {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  await fs.writeFile(tmpPath, text, 'utf8');
  await fs.rename(tmpPath, filePath);
}

// cmd.exe can break out of a quoted arg on an embedded `"`, `%VAR%` expansion,
// or trailing `\` (arg injection), so reject those instead of trying to escape them.
const WIN32_UNSAFE_CHARS = /["%]|\\$/;

export class SpawnUtilsError extends Error {}

export function assertWin32Safe(arg, { platform = process.platform } = {}) {
  if (platform === 'win32' && WIN32_UNSAFE_CHARS.test(String(arg))) {
    throw new SpawnUtilsError(
      `argument "${arg}" contains a character unsafe to pass through cmd.exe on Windows ` +
        `(a double quote, a percent sign, or a trailing backslash) — rename the path/value ` +
        `to avoid these characters`
    );
  }
  return arg;
}

export function winQuote(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

// child.killed means the signal was sent, not that the process exited, so it
// never reflects whether SIGTERM actually worked; escalation must wait for
// the real 'exit' event instead. Killing the negative pid targets the whole
// process group (spawnCli sets detached:true on POSIX for this reason), not
// just the direct child, so a forked grandchild doesn't get orphaned.
// waitForGroup: resolve only once the whole group is gone or got SIGKILL, for a caller that exits
// right after (a signal handler would otherwise exit before the escalation runs).
// The groups the child's own tree leads are signalled with it (readTable; off when a test injects kill).
export function posixKillTree(child, { kill = realKill, escalateMs = 5000, waitForGroup = false, readTable = kill === realKill ? processTable : () => null } = {}) {
  return new Promise((resolvePromise) => {
    if (!child.pid) { resolvePromise(); return; }
    let exited = false;
    const table = readTable();
    const groups = [...new Set([child.pid, ...(table ? treeGroups(child.pid, table) : [])])];
    const send = (sig) => {
      // EPERM: a group of another user's processes (a sudo child) is skipped, and the other groups are still signalled.
      for (const g of groups) {
        try { kill(-g, sig); } catch (err) { if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err; }
      }
    };
    const groupAlive = () => groups.some((g) => {
      try { kill(-g, 0); return true; } catch { return false; }
    });
    child.once('exit', () => { exited = true; if (!waitForGroup || !groupAlive()) resolvePromise(); });
    send('SIGTERM');
    // Runs even after the leader exited: a group member that ignored SIGTERM would otherwise live on.
    setTimeout(() => {
      if (groupAlive()) send('SIGKILL');
      if (waitForGroup) resolvePromise();
      // Bound the wait even if the group ignores SIGKILL (e.g. already reaped).
      else if (!exited) setTimeout(() => { if (!exited) resolvePromise(); }, 1000);
    }, escalateMs);
  });
}

// On win32, spawnCli runs the child under cmd.exe (shell:true), so child.pid is
// cmd.exe's PID and child.kill() only terminates cmd.exe; the real process
// behind it (codex.exe, opencode's shim, or an --exec'd command) would be
// orphaned and keep running. taskkill /T kills the whole process tree.
// `log`: caller-supplied logger (each caller uses its own message prefix),
// defaults to a no-op so a caller that doesn't care about the failure path
// doesn't need to supply one. `kill`/`escalateMs` forward to posixKillTree
// unchanged -- exposed here (not hidden behind a fixed default) so a test on
// the POSIX branch can inject a recording fake `kill` instead of sending a
// real signal to an arbitrary pid, which would otherwise reach a real
// process group on a Linux/macOS CI runner if one happened to match.
export function killTree(child, { log = () => {}, platform = process.platform, kill, escalateMs, waitForGroup } = {}) {
  if (platform === 'win32') {
    // Absolute path, not "taskkill": a caller may have narrowed PATH down to
    // just the CLI it wants dispatched, and taskkill.exe would not resolve.
    const taskkillPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise((resolvePromise) => {
      const killer = spawn(taskkillPath, ['/pid', String(child.pid), '/T', '/F']);
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolvePromise(); } };
      killer.on('error', (err) => { log(`taskkill failed: ${err.message}`); finish(); });
      killer.on('close', finish);
      setTimeout(finish, 5000);
    });
  }
  return posixKillTree(child, { kill, escalateMs, waitForGroup });
}

// spawnFn/platform are overridable so tests can assert the exact options passed to spawn() on
// a POSIX branch (detached:true, shell:false) without needing to actually run on POSIX.
export function spawnCli(cmd, args, opts, { spawnFn = spawn, platform = process.platform } = {}) {
  const needsShell = platform === 'win32';
  if (needsShell) {
    for (const a of [cmd, ...args]) assertWin32Safe(a, { platform });
    const cmdLine = [winQuote(cmd), ...args.map(winQuote)].join(' ');
    return spawnFn(cmdLine, { ...opts, shell: true });
  }
  // detached:true puts the child in its own process group so posixKillTree
  // can kill(-pid) the whole group, not just the direct child.
  return spawnFn(cmd, args, { ...opts, shell: false, detached: true });
}
