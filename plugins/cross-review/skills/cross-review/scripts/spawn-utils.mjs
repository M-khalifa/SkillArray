// Shared win32-safe process spawning and tree-killing, used by both dispatchers and by preflight.mjs for its own
// --exec-spawned child.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// pid -> { ppid, pgid, start } for every process: from /proc on Linux (no procps needed), from ps elsewhere, null when
// neither can be read. Fields 4, 5 and 22 (start time in clock ticks) of /proc/<pid>/stat, counted after the last ")"
// since the name may hold one; elsewhere ps's lstart (to the second, so a pid reused in the same second compares equal).
// macOS ships ps at /bin/ps: called by its path, a PATH without /bin or a planted ps changes nothing.
export const psBinary = (platform = process.platform) => (platform === 'darwin' ? '/bin/ps' : 'ps');
const psTable = () => spawnSync(psBinary(), ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 20000 });
export function processTable({ platform = process.platform, runPs = psTable } = {}) {
  if (platform === 'win32') return null;
  if (platform === 'linux') {
    try {
      const table = new Map();
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let text;
        try { text = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
        table.set(Number(name), { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] });
      }
      return table;
    } catch { /* no /proc: try ps */ }
  }
  const res = runPs();
  if (res.status !== 0) return null;
  const table = new Map();
  for (const line of (res.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), start: m[4].replace(/\s+/g, ' ') });
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

// Each process with its environment ("pid command ENV=..."); all of them together can exceed the 1 MB default buffer.
const psEnv = () => spawnSync(psBinary(), ['eww', '-axo', 'pid=,command='], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, timeout: 20000, maxBuffer: 1 << 28 });

// macOS: the same search over ps's environment column. macOS hides the environment of Apple's own system programs
// (/bin/sh, /bin/sleep, /usr/bin/perl), so such a job is not found; a process whose arguments hold the marker matches.
function stopMarkedFromPs(marker, { readPsEnv, kill, self }) {
  const res = readPsEnv();
  if (res.error || res.status !== 0) return [];
  const left = [];
  for (const line of (res.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    // Pid 0 would signal this process's own group and pid 1 is launchd: never targets.
    if (!m || Number(m[1]) <= 1 || Number(m[1]) === self || !m[2].split(/\s+/).includes(marker)) continue;
    try {
      kill(Number(m[1]), 'SIGKILL');
      left.push(Number(m[1]));
    } catch { /* it exited meanwhile */ }
  }
  return left;
}

// Linux and macOS: every process that still carries the seat run's id in its environment (REVIEW_SEAT_RUN_ID, inherited by
// each tool command and background job the CLI started, also one that left its group or session) is killed; the pids are returned.
export function stopMarkedProcesses(runId, { readEnviron = (pid) => readFileSync(`/proc/${pid}/environ`, 'latin1'), listPids = () => readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number), readPsEnv = psEnv, kill = realKill, platform = process.platform, self = process.pid } = {}) {
  if (platform === 'darwin' && runId) return stopMarkedFromPs(`REVIEW_SEAT_RUN_ID=${runId}`, { readPsEnv, kill, self });
  if (platform !== 'linux' || !runId) return [];
  const marker = `REVIEW_SEAT_RUN_ID=${runId}`;
  const left = [];
  let pids;
  try { pids = listPids(); } catch { return []; }
  for (const pid of pids) {
    if (pid === self) continue;
    let environ;
    try { environ = readEnviron(pid); } catch { continue; }
    if (!environ.split('\0').includes(marker)) continue;
    try {
      kill(pid, 'SIGKILL');
      left.push(pid);
    } catch { /* it exited meanwhile */ }
  }
  return left;
}

// The process groups a seat's tool commands lead, remembered while the CLI runs: a tool shell that started a background job
// and then exited leaves the job in a group whose leader is gone, which treeGroups can no longer find. Sampled every
// intervalMs with each member's start; stop() kills a remembered group only while one of its members is a process seen
// in it (same pid and start), so a reused group id is left alone, and returns the pids it found there. POSIX only.
export function watchTreeGroups(rootPid, { intervalMs = 1000, readTable = processTable, kill = realKill, platform = process.platform } = {}) {
  if (platform === 'win32' || !Number.isInteger(rootPid)) return null;
  const seen = new Map();
  // The CLI's own start, from the first sample: once it is gone (or its pid now holds another process) sampling ends.
  let rootStart;
  let ended = false;
  let timer = null;
  const sample = () => {
    if (ended) return;
    const table = readTable();
    if (!table) return;
    const root = table.get(rootPid);
    if (rootStart === undefined && root) rootStart = root.start ?? null;
    if (!root || (root.start ?? null) !== rootStart) {
      ended = true;
      clearInterval(timer);
      return;
    }
    for (const g of treeGroups(rootPid, table)) {
      const members = seen.get(g) ?? new Map();
      for (const [p, info] of table) if (info.pgid === g) members.set(p, info.start);
      seen.set(g, members);
    }
  };
  sample();
  if (!ended) {
    timer = setInterval(sample, intervalMs);
    timer.unref?.();
  }
  return {
    sample,
    stop() {
      clearInterval(timer);
      const table = readTable();
      if (!table) return [];
      const left = [];
      for (const [g, members] of seen) {
        const now = [...table].filter(([, info]) => info.pgid === g).map(([p, info]) => ({ p, start: info.start }));
        if (!now.some(({ p, start }) => members.has(p) && members.get(p) === start)) continue;
        try {
          kill(-g, 'SIGKILL');
          left.push(...now.map(({ p }) => p));
        } catch { /* the group emptied meanwhile */ }
      }
      return left;
    },
  };
}

// A command a seat CLI or --exec ran in the background stays in the child's own process group after the child exits, and
// holds its output pipes open. The group id belongs to those descendants until the last one exits (it cannot be reused
// meanwhile), so it is killed when the child exits. POSIX only: a Windows tree has no group to signal.
// onKilled runs when the kill reached the group, so something the child started was still in it.
export function killGroupOnExit(child, { platform = process.platform, kill = realKill, onKilled = () => {} } = {}) {
  if (platform === 'win32') return;
  child.once('exit', () => {
    if (!child.pid) return;
    try {
      kill(-child.pid, 'SIGKILL');
      onKilled();
    } catch { /* ESRCH: nothing was left in the group */ }
  });
}

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

// Windows refuses a rename for a moment while another process holds the file (a virus scan, a reader): EPERM or
// EBUSY. A detached worker that threw here died with its result.json still "running". Retry; on the last refusal the
// temp file is removed and the error thrown.
export async function renameRetrying(from, to, { rename = fs.rename, tries = 10, delayMs = 500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < tries) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      await fs.rm(from, { force: true }).catch(() => {});
      throw err;
    }
  }
}

// result.json through a temp file and a rename, so a reader never sees a half-written record.
export async function atomicWriteJson(filePath, data, { rename } = {}) {
  const tmpPath = path.join(path.dirname(filePath), `.result.json.tmp-${process.pid}`);
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await renameRetrying(tmpPath, filePath, { rename });
}

// --final-message-out: the seat's final message as UTF-8 without BOM, via temp file + rename,
// so an orchestrator never re-saves it through a shell that re-encodes it.
export async function writeFinalMessage(filePath, text) {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  await fs.writeFile(tmpPath, text, 'utf8');
  await renameRetrying(tmpPath, filePath);
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

// On Windows an --exec command or a seat CLI runs inside a job object, so every process it starts stays findable after the process that
// started it has exited (a launcher that spawns a detached server and exits). A PowerShell wrapper puts itself in a new job
// (stop its processes when the job closes; a process may still ask to break away), runs the command through cmd.exe exactly
// as shell:true does, then writes the job's leftover pids ("left <pids>", or "nojob <reason>") to a report file and stops
// them. The command, report path and original PSModulePath arrive in variables the wrapper removes before the command runs.
const JOB_WRAPPER = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$report = $env:PREFLIGHT_EXEC_REPORT
$cmd = $env:PREFLIGHT_EXEC_COMMAND
$modules = $env:PREFLIGHT_EXEC_PSMODULEPATH
$dll = $env:PREFLIGHT_EXEC_JOBDLL
$inJob = $false
try {
$src = @'
using System;
using System.Runtime.InteropServices;
public static class PreflightJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] public struct Ext { public Basic Basic; public Io Io; public UIntPtr P1, P2, P3, P4; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, IntPtr n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Ext i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, int l, IntPtr r);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr job;
  public static void Enter() {
    job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    Ext e = new Ext();
    e.Basic.LimitFlags = 0x2000 | 0x800;
    if (!SetInformationJobObject(job, 9, ref e, (uint)Marshal.SizeOf(typeof(Ext)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
  }
  public static int[] Pids() {
    int size = 8 + 4096 * IntPtr.Size;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) throw new Exception("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
      int n = Marshal.ReadInt32(buf, 4);
      int[] r = new int[n];
      for (int i = 0; i < n; i++) r[i] = (int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
      return r;
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
'@
# Compiled once into a DLL named after this source's hash (compiling costs seconds per command, loading well under one).
if (-not (Test-Path -LiteralPath $dll)) {
  $tmp = "$dll.$PID.tmp"
  Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library
  try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
# Loaded through .NET: the Add-Type cmdlet would load its PowerShell module first (about 2 seconds).
try { [void][Reflection.Assembly]::LoadFrom($dll) } catch { Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue; throw }
[PreflightJob]::Enter()
$inJob = $true
} catch { [IO.File]::WriteAllText($report, "nojob " + $_.Exception.Message) }
foreach ($name in 'PREFLIGHT_EXEC_REPORT', 'PREFLIGHT_EXEC_COMMAND', 'PREFLIGHT_EXEC_PSMODULEPATH', 'PREFLIGHT_EXEC_JOBDLL') { [Environment]::SetEnvironmentVariable($name, $null) }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })
$psi.Arguments = '/d /s /c "' + $cmd + '"'
$psi.UseShellExecute = $false
# Only the command's copy changes: PowerShell took about 20 s per wrapper on a GitHub runner after its own PSModulePath changed.
[void]$psi.EnvironmentVariables.Remove('PSModulePath')
if ($modules -ne '<unset>') { $psi.EnvironmentVariables['PSModulePath'] = $modules }
$p = [System.Diagnostics.Process]::Start($psi)
$p.WaitForExit()
$code = $p.ExitCode
if ($inJob) {
  $left = @([PreflightJob]::Pids() | Where-Object { $_ -ne $PID })
  [IO.File]::WriteAllText($report, "left " + ($left -join ' '))
  foreach ($id in $left) { try { [System.Diagnostics.Process]::GetProcessById($id).Kill() } catch { } }
}
exit $code
`;

// Starts a command line through the job wrapper; the report file (in a new temp folder) says what was left and stopped.
export function jobSpawn(command, { cwd, env, spawnFn = spawn } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-exec-'));
  const report = path.join(dir, 'job.txt');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The job helper is compiled once per version of JOB_WRAPPER and kept next to the other temp files.
  const jobDll = path.join(tmpdir(), `review-preflight-job-${createHash('sha256').update(JOB_WRAPPER).digest('hex').slice(0, 16)}.dll`);
  const modulePath = (source) => Object.entries(source).find(([k]) => k.toLowerCase() === 'psmodulepath')?.[1];
  const vars = { PREFLIGHT_EXEC_JOBDLL: jobDll, PREFLIGHT_EXEC_COMMAND: command, PREFLIGHT_EXEC_REPORT: report, PREFLIGHT_EXEC_PSMODULEPATH: modulePath(env ?? process.env) ?? '<unset>' };
  // The wrapper itself starts with this process's PSModulePath: without it PowerShell took about 20 s to run the wrapper on a
  // GitHub Windows runner. The command still gets the PSModulePath of `env` (PREFLIGHT_EXEC_PSMODULEPATH above).
  const own = modulePath(process.env);
  const shellEnv = { ...Object.fromEntries(Object.entries(env ?? process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath')), ...(own === undefined ? {} : { PSModulePath: own }), ...vars };
  const child = spawnFn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(JOB_WRAPPER, 'utf16le').toString('base64')], { windowsHide: true, cwd, env: shellEnv });
  return { child, report, dir };
}

// The job wrapper's report: { left: [pids it stopped] }, { refused: why no job could be used }, or { unreadable: why }.
export function readJobReport(report) {
  let text = '';
  try {
    text = readFileSync(report, 'utf8');
  } catch (err) {
    return { unreadable: err.code || err.message };
  }
  if (!text.startsWith('left')) return { refused: text.replace(/^nojob\s*/, '').trim() };
  return { left: text.slice(4).trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite) };
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
// behind it (codex.exe, claude's shim, or an --exec'd command) would be
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
      const killer = spawn(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      let settled = false;
      // taskkill is not detached, so it dies when this process exits: wait for it (a loaded host can take over 5 s).
      const cap = setTimeout(() => finish(), 30000);
      const finish = () => { if (!settled) { settled = true; clearTimeout(cap); resolvePromise(); } };
      killer.on('error', (err) => { log(`taskkill failed: ${err.message}`); finish(); });
      killer.on('close', finish);
    });
  }
  return posixKillTree(child, { kill, escalateMs, waitForGroup });
}

// A child that has exited (its pid may belong to another process by now, so it is never signalled again).
export function hasExited(child) {
  return Number.isInteger(child?.exitCode) || Boolean(child?.signalCode);
}

// How long a seat CLI may keep running after its final answer before its tree is stopped (its exit hooks run in this time).
export function answerGraceMs(env = process.env) {
  return Number(env.REVIEW_ANSWER_GRACE_MS) || 30000;
}

// spawnFn/platform are overridable so tests can assert the exact options passed to spawn() on
// a POSIX branch (detached:true, shell:false) without needing to actually run on POSIX.
// job (Windows): run it through the job wrapper; the child then carries jobReport and jobDir.
export function spawnCli(cmd, args, opts, { spawnFn = spawn, platform = process.platform, job = false } = {}) {
  const needsShell = platform === 'win32';
  if (needsShell) {
    for (const a of [cmd, ...args]) assertWin32Safe(a, { platform });
    const cmdLine = [winQuote(cmd), ...args.map(winQuote)].join(' ');
    if (job) {
      const { child, report, dir } = jobSpawn(cmdLine, { cwd: opts.cwd, env: opts.env, spawnFn });
      return Object.assign(child, { jobReport: report, jobDir: dir });
    }
    // windowsHide: a caller with no console (a detached worker, an agent tool shell) would otherwise open a console window per child.
    return spawnFn(cmdLine, { windowsHide: true, ...opts, shell: true });
  }
  // detached:true puts the child in its own process group so posixKillTree
  // can kill(-pid) the whole group, not just the direct child.
  return spawnFn(cmd, args, { windowsHide: true, ...opts, shell: false, detached: true });
}
