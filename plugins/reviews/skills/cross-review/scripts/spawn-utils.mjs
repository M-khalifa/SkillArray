// Shared win32-safe process spawning and tree-killing, extracted from
// codex-dispatch.mjs and opencode-dispatch.mjs (pure extraction, no behavior
// change -- both dispatchers' own test suites pass unchanged against this
// module). Used by both dispatchers and by preflight.mjs for its own
// --exec-spawned child.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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
export function posixKillTree(child, { kill = (pid, sig) => process.kill(pid, sig), escalateMs = 5000 } = {}) {
  return new Promise((resolvePromise) => {
    if (!child.pid) { resolvePromise(); return; }
    let exited = false;
    child.once('exit', () => { exited = true; resolvePromise(); });
    const send = (sig) => {
      try { kill(-child.pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    };
    send('SIGTERM');
    setTimeout(() => {
      if (exited) return;
      send('SIGKILL');
      // Bound the wait even if the group ignores SIGKILL (e.g. already reaped).
      setTimeout(() => { if (!exited) resolvePromise(); }, 1000);
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
export function killTree(child, { log = () => {}, platform = process.platform, kill, escalateMs } = {}) {
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
  return posixKillTree(child, { kill, escalateMs });
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
