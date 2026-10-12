import { appendFileSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { buildChildEnv } from './env-filter.mjs';
import { completedRunRefusal, preserveEarlierResult } from './spawn-utils.mjs';

export const DEFAULT_MAX_WAIT_S = 540;
export const START_TOLERANCE_MS = 10000;
const VERIFIED_FOR_MS = 30000;
const verifiedAt = new Map();

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Start time of a live process in ms since the epoch, or null when the OS cannot say.
export function processStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const ps = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
    const res = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const ms = res.status === 0 ? Date.parse((res.stdout || '').trim()) : NaN;
    return Number.isNaN(ms) ? null : ms;
  }
  const res = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 20000 });
  const m = res.status === 0 ? /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(res.stdout || '') : null;
  if (!m) return null;
  const seconds = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
  return Date.now() - seconds * 1000;
}

// Field 22 of /proc/<pid>/stat (start time in clock ticks since boot), read after the last ")" because the
// command name in field 2 may hold spaces and parentheses. Null when the text has no such field.
export function startTokenFromProcStat(text) {
  const raw = String(text ?? '');
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  return /^[0-9]+$/.test(fields[19] ?? '') ? `ticks:${fields[19]}` : null;
}

// A start marker the OS stores itself, so a later change of the wall clock cannot move it: clock ticks since boot
// on Linux, ps's recorded start on other POSIX systems. Null on Windows (which reads the stored StartTime) and
// whenever the OS reports nothing; callers then fall back to the wall-clock comparison.
export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      return startTokenFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return null;
    }
  }
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 20000 });
  const text = res.status === 0 ? (res.stdout || '').trim() : '';
  return text ? `lstart:${text}` : null;
}

// A pid counts as the recorded worker only while it exists and, when a worker start time was recorded and
// the OS can report the process start time, the two agree. A reused pid started later, so it fails the match.
// A recorded start token, when the OS can read one for the pid, decides on its own and ignores the wall clock.
export function workerIsLive(pid, recordedStart, { readStart = processStartMs, readToken = processStartToken, recordedToken = null, now = Date.now(), toleranceMs = START_TOLERANCE_MS } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return false;
  if (recordedToken) {
    const token = readToken(pid);
    if (token != null) return token === recordedToken;
  }
  const recorded = Date.parse(recordedStart ?? '');
  if (Number.isNaN(recorded)) return true;
  const key = `${pid}|${recordedStart}`;
  if (now - (verifiedAt.get(key) ?? -Infinity) < VERIFIED_FOR_MS) return true;
  const start = readStart(pid);
  if (start == null) return true;
  if (Math.abs(start - recorded) > toleranceMs) return false;
  verifiedAt.set(key, now);
  return true;
}

export function retryDeadline(text, now = new Date()) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?\s*$/i.exec(text ?? '');
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return null;
  const at = new Date(now);
  at.setHours((Number(m[1]) % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0), Number(m[2]), 0, 0);
  if (now - at > 12 * 3600 * 1000) at.setDate(at.getDate() + 1);
  return at;
}

// Dispatcher callbacks preserve each provider's result schema and error type.
export function createDetachHandlers({ scriptPath, dispatch, runningRecord, atomicWriteJson, RelayError, log, workerEnvNames = ['PATH', 'CODEX_HOME'] }) {
  const JOB_FILE = 'dispatch-job.json';
  const WORKER_LOG = 'dispatch-worker.log';

  // REVIEW_DETACH_MODE: auto (default) starts the worker through WMI on Windows, which leaves the host's job object,
  // and falls back to a plain detached process when WMI is refused (as it is inside a Codex sandbox); plain skips WMI;
  // wmi never falls back.
  function launchWorker(jobPath, cwd) {
    const script = scriptPath;
    const mode = process.env.REVIEW_DETACH_MODE || 'auto';
    const plain = () => {
      const child = spawn(process.execPath, [script, '--job', jobPath], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return child.pid;
    };
    if (process.platform !== 'win32' || mode === 'plain') return plain();
    try {
      return launchThroughWmi(jobPath, cwd);
    } catch (err) {
      if (mode === 'wmi' || !(err instanceof RelayError)) throw err;
      log(`${err.message}; started the worker as a plain detached process instead (it ends with the host job if the host stops its child processes)`);
      return plain();
    }
  }

  function launchThroughWmi(jobPath, cwd) {
    const script = scriptPath;
    const q = (s) => s.replace(/'/g, "''");
    const commandLine = `"${process.execPath}" "${script}" --job "${jobPath}"`;
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(commandLine)}'; CurrentDirectory = '${q(cwd)}' }; ` +
      '"$($r.ReturnValue) $($r.ProcessId)"';
    // REVIEW_DETACH_POWERSHELL names another PowerShell for the WMI call (a test makes it fail this way).
    const powershell = process.env.REVIEW_DETACH_POWERSHELL || (process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe');
    const res = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    const m = /^(\d+) (\d+)\s*$/.exec((res.stdout || '').trim());
    if (res.status !== 0 || !m || m[1] !== '0') {
      throw new RelayError(`could not start the detached worker through WMI: ${(res.stderr || res.stdout || '').trim() || res.error?.message || `exit ${res.status}`}`);
    }
    return Number(m[2]);
  }

  async function runDetach(args, argv) {
    const briefDir = path.dirname(path.resolve(args.brief));
    const resultPath = path.join(briefDir, 'result.json');
    if (!args.replaceCompleted) {
      const refusal = await completedRunRefusal(args.finalMessageOut);
      if (refusal) {
        log(refusal);
        process.exit(2);
      }
    }
    const kept = await preserveEarlierResult(resultPath);
    if (kept) log(`kept the earlier result.json as ${path.basename(kept)}`);
    const jobPath = path.join(briefDir, JOB_FILE);
    const workerLog = path.join(briefDir, WORKER_LOG);
    const env = {};
    const filtered = buildChildEnv({ envMode: 'filtered', providerAllowlist: Object.keys(process.env).filter((k) => workerEnvNames.some((name) => name.toLowerCase() === k.toLowerCase())) });
    for (const [k, v] of Object.entries(filtered)) if (workerEnvNames.some((name) => name.toLowerCase() === k.toLowerCase())) env[k] = v;
    await fs.writeFile(jobPath, JSON.stringify({ argv: argv.filter((a) => a !== '--detach'), cwd: process.cwd(), env }, null, 2) + '\n', 'utf8');
    await fs.rm(workerLog, { force: true });
    const startedAt = new Date().toISOString();
    await atomicWriteJson(resultPath, runningRecord(args, { startedAt, worker: { detached: true, workerPid: null, workerLog } }));
    const pid = launchWorker(jobPath, process.cwd());
    process.stdout.write(
      `relay: detached worker pid ${pid} started; its log is ${workerLog}.\n` +
        `relay: wait with: node "${scriptPath}" --wait "${resultPath}"\n`
    );
    process.exit(0);
  }

  function waitExit(line, code) {
    process.stdout.write(line);
    if (code !== 0) process.stderr.write(line);
    process.exit(code);
  }

  async function runWait(argv) {
    const resultPath = argv[0];
    if (!resultPath || resultPath.startsWith('--')) throw new RelayError('--wait requires the path of a result.json');
    let maxWait = DEFAULT_MAX_WAIT_S;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--max-wait' && /^[0-9]+$/.test(argv[i + 1] ?? '')) maxWait = Number(argv[++i]);
      else throw new RelayError(`--wait accepts only --max-wait <seconds>, got "${argv[i]}"`);
    }
    const began = Date.now();
    for (;;) {
      let rec = null;
      try {
        rec = JSON.parse((await fs.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
      } catch (err) {
        if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw new RelayError(`cannot read ${resultPath}: ${err.message}`);
      }
      if (rec && rec.status !== 'running') {
        waitExit(`relay: finished with status "${rec.status}"${rec.threadId ? `, threadId ${rec.threadId}` : ''}\n`, rec.status === 'completed' ? 0 : 1);
      }
      if (rec && rec.workerPid && !workerIsLive(rec.workerPid, rec.workerStartedAt, { recordedToken: rec.workerStartToken })) {
        waitExit(
          `relay: worker ${rec.workerPid} is gone but result.json still says "running"` +
            (rec.threadId ? `; resume thread ${rec.threadId} with --session` : '; no thread was started, so dispatch again') +
            `. Its log: ${rec.workerLog ?? WORKER_LOG}\n`,
          1
        );
      }
      if (rec && !rec.workerPid && Date.now() - Date.parse(rec.startedAt) > 120000) {
        waitExit(`relay: the detached worker never started (no workerPid after 2 minutes); see ${rec.workerLog ?? WORKER_LOG}\n`, 1);
      }
      if (maxWait && Date.now() - began > maxWait * 1000) {
        waitExit('relay: still running; run --wait again\n', 3);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function runWaitRetry(argv) {
    const resultPath = argv[0];
    if (!resultPath || resultPath.startsWith('--')) throw new RelayError('--wait-retry requires the path of a result.json');
    let maxWait = DEFAULT_MAX_WAIT_S;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--max-wait' && /^[0-9]+$/.test(argv[i + 1] ?? '')) maxWait = Number(argv[++i]);
      else throw new RelayError(`--wait-retry accepts only --max-wait <seconds>, got "${argv[i]}"`);
    }
    let rec;
    try {
      rec = JSON.parse((await fs.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new RelayError(`cannot read ${resultPath}: ${err.message}`);
    }
    if (rec.status !== 'rate-limited') throw new RelayError(`${resultPath} has status "${rec.status}", not "rate-limited"; there is no limit to wait for`);
    const deadline = retryDeadline(rec.retryAfter);
    if (!deadline) throw new RelayError(`retryAfter ${JSON.stringify(rec.retryAfter)} is not a plain clock time such as "3:06 PM"; wait until then yourself`);
    const resume = rec.threadId ? `resume thread ${rec.threadId} with --session, or start a new dispatch` : 'no thread was started, so dispatch again';
    const began = Date.now();
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        process.stdout.write(`relay: the usage limit ended at ${deadline.toLocaleTimeString()}; ${resume}\n`);
        process.exit(0);
      }
      if (maxWait && Date.now() - began >= maxWait * 1000) {
        waitExit(`relay: ${Math.ceil(left / 1000)} s left until ${deadline.toLocaleTimeString()}; run --wait-retry again\n`, 3);
      }
      const untilMax = maxWait ? maxWait * 1000 - (Date.now() - began) : left;
      await new Promise((r) => setTimeout(r, Math.max(50, Math.min(30000, left, untilMax))));
    }
  }

  async function runJob(jobPath) {
    let job;
    try {
      job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
    } catch (err) {
      throw new RelayError(`cannot read job file ${jobPath}: ${err.message}`);
    }
    const logPath = path.join(path.dirname(jobPath), WORKER_LOG);
    const toLog = (chunk, enc, cb) => {
      appendFileSync(logPath, chunk);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    process.stdout.write = toLog;
    process.stderr.write = toLog;
    for (const k of Object.keys(process.env)) if (workerEnvNames.some((name) => name.toLowerCase() === k.toLowerCase())) delete process.env[k];
    Object.assign(process.env, job.env ?? {});
    process.chdir(job.cwd);
    const workerStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    return dispatch(job.argv, { worker: { detached: true, workerPid: process.pid, workerStartedAt, workerStartToken: processStartToken(process.pid), workerLog: logPath } });
  }

  return { runDetach, runWait, runWaitRetry, runJob };
}
