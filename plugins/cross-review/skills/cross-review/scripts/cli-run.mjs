// One seat CLI run, the same for every runtime: start the CLI, send the brief on stdin, hand each stdout line to the
// runtime's adapter, and end the run on the first of: its close, a short wait after it exited without an answer (a
// process it started may hold its output), the stop after its answer, the timeout, or a stop signal. A CLI that has
// exited is never signalled: its pid may belong to another process by now.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import readline from 'node:readline';
import process from 'node:process';
import { answerGraceMs, hasExited, killGroupOnExit, killTree, readJobReport, spawnCli, stopMarkedProcesses, watchTreeGroups } from './spawn-utils.mjs';

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// detached:true (for posixKillTree's group-kill) moves the child out of this process's controlling-terminal group, so
// Ctrl+C no longer reaches it directly; without this, an interrupted dispatcher orphans the reviewer.
// onSignal tells the runner a stop is under way: the child's close must not resolve a run that the exit below ends.
export function installSignalForwarding(child, { proc = process, killTreeFn, exit, onSignal = () => {}, log = () => {} }) {
  const handlers = {};
  // Kept installed: a second signal (Ctrl-C pressed again) must not reach Node's default handler mid-kill.
  let stopping = false;
  for (const [sig, code] of Object.entries(SIGNAL_EXIT_CODE)) {
    handlers[sig] = () => {
      if (stopping) return;
      stopping = true;
      onSignal();
      log(`received ${sig}, terminating reviewer process`);
      (hasExited(child) ? Promise.resolve() : killTreeFn(child, { waitForGroup: true })).finally(() => exit(code));
    };
    proc.on(sig, handlers[sig]);
  }
  return () => { for (const [sig, handler] of Object.entries(handlers)) proc.off(sig, handler); };
}

// On Windows the CLI runs in a job object, which stops what it started when it ends; REVIEW_SEAT_JOB=off turns that off.
export const seatJob = (env = process.env, platform = process.platform) => platform === 'win32' && env.REVIEW_SEAT_JOB !== 'off';

// onLine(line) is the runtime's adapter: it returns true for the line that completes a successful final answer.
// exit(code) ends the process after a stop signal (the dispatcher's own exit). Resolves with the run's outcome:
// { code, timedOut, stoppedAfterAnswer, stoppedAtTimeout, exitedBeforeStop, stopIncomplete, exitedOutputOpen, stderr, leftoversStopped, jobRefused }.
export function runCli({ command, args, cwd, env, input, timeoutS = 0, onLine, onSpawn = () => {}, onStderr = () => {}, log = () => {}, exit, start = spawnCli, job = seatJob() }) {
  return new Promise((resolve, reject) => {
    let child;
    // Every process the CLI starts inherits this id, so on Linux and macOS what it leaves running is found also outside its groups.
    const runId = randomUUID();
    try {
      child = start(command, args, { cwd, env: { ...(env ?? process.env), REVIEW_SEAT_RUN_ID: runId } }, { job });
    } catch (error) {
      reject(new Error(`failed to spawn "${command}": ${error.message}`));
      return;
    }
    // The dispatcher records the id beside the CLI's pid, so a stop by a later step can find what the CLI left.
    child.reviewRunId = runId;
    killGroupOnExit(child);
    // POSIX: the groups the CLI's tool commands lead, so a background job one of them left is stopped when the run ends.
    const groups = watchTreeGroups(child.pid);
    const stopLeftGroups = () => {
      const left = [...new Set([...(groups?.stop() ?? []), ...stopMarkedProcesses(runId)])];
      if (left.length === 0) return;
      out.leftoversStopped = [...(out.leftoversStopped ?? []), ...left];
      log(`WARNING: ${command} left ${left.length} process(es) running in its tool commands' process groups (pid ${left.join(', ')}); they were stopped`);
    };
    const noteJobRefused = (why) => {
      out.jobRefused = why;
      log(`WARNING: ${command} could not run in a job object (${why}); a process it starts can outlive it`);
    };
    // The job wrapper's report folder goes on every way the run ends, a stop signal and a failed spawn included. A
    // refused job is written when the wrapper starts, so it is read here too: a stopped or timed-out run reports it.
    const removeJobDir = () => {
      if (!child.jobDir) return;
      if (child.jobReport && out.jobRefused === undefined && out.leftoversStopped === undefined) {
        const report = readJobReport(child.jobReport);
        if (report?.refused !== undefined) noteJobRefused(report.refused);
      }
      try { rmSync(child.jobDir, { recursive: true, force: true, maxRetries: 5 }); } catch (error) { log(`could not remove the job report folder ${child.jobDir}: ${error.message}`); }
    };
    const killChild = (target, options = {}) => killTree(target, { log, ...options });
    let stopping = false;
    const uninstall = installSignalForwarding(child, { killTreeFn: killChild, exit: (code) => { stopLeftGroups(); removeJobDir(); exit(code); }, log, onSignal: () => { stopping = true; } });
    onSpawn(child);
    const out = { code: null, timedOut: false, stoppedAfterAnswer: false, stderr: '' };
    let timer = null;
    let grace = null;
    let answered = null;
    let exitWait = null;
    let settled = false;
    // The caller exits right after this resolves, so a stop waits for the whole process group to be killed.
    let killing = null;
    const rl = readline.createInterface({ input: child.stdout });
    const cleanup = () => {
      uninstall();
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(answered);
      clearTimeout(exitWait);
      rl.close();
      stopLeftGroups();
      removeJobDir();
    };
    const finish = (fields = {}) => {
      settled = true;
      Object.assign(out, fields);
      cleanup();
      resolve(out);
    };
    // The answer is kept and the CLI's tree is stopped: after the answer grace, or when the timeout fires inside it.
    const stopAfterAnswer = () => {
      out.stoppedAfterAnswer = true;
      clearTimeout(timer);
      clearTimeout(answered);
      if (hasExited(child)) {
        // The answer was a success; how the CLI ended after it does not undo that (the warning says what happened).
        finish({ code: 0, exitedBeforeStop: true, stopIncomplete: true });
        return;
      }
      killing = killChild(child, { waitForGroup: true }).catch((error) => log(`tree kill failed: ${error.message}`));
      // The kill may escalate (SIGTERM, then SIGKILL): its close gets a second after the kill has finished.
      grace = setTimeout(() => {
        killing.finally(() => grace = setTimeout(() => {
          if (settled || stopping) return;
          // Its output is still open: a process it started (one that left its tree) may still be running.
          finish({ code: 0, stopIncomplete: true });
        }, 1000));
      }, 5000);
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`failed to spawn "${command}": ${error.message}`));
    });
    if (timeoutS) {
      timer = setTimeout(() => {
        // It already exited and only its output is open: no kill; after an answer the run ends as answered, else as the
        // exit wait ends it (its exit code, output still open), not as a kill.
        if (hasExited(child)) {
          if (settled || stopping) return;
          if (answered) finish({ stoppedAfterAnswer: true, stoppedAtTimeout: true, exitedBeforeStop: true, stopIncomplete: true, code: 0 });
          else finish({ code: child.exitCode ?? 1, stopIncomplete: true, exitedOutputOpen: true });
          return;
        }
        if (answered) {
          out.stoppedAtTimeout = true;
          stopAfterAnswer();
          return;
        }
        out.timedOut = true;
        killing = killChild(child, { waitForGroup: true }).catch((error) => log(`tree kill failed: ${error.message}`));
        // A kill that cannot reach the real process still ends the run, so the timeout bounds wall-clock time.
        grace = setTimeout(() => {
          killing.finally(() => {
            if (settled || stopping) return;
            finish();
          });
        }, 5000);
      }, timeoutS * 1000);
    }
    rl.on('line', (line) => {
      if (!onLine(line) || answered) return;
      // A CLI that keeps running after a successful answer is stopped, and the answer kept.
      answered = setTimeout(() => {
        if (settled || stopping || killing) return;
        stopAfterAnswer();
      }, answerGraceMs());
    });
    child.stderr.on('data', (chunk) => {
      out.stderr += chunk.toString('utf8');
      onStderr(chunk);
    });
    child.stdin.on('error', (error) => log(`stdin write failed: ${error.message}`));
    child.stdin.end(input);
    // An exit with no successful answer whose output stays open must not wait for a close that never comes (review-run
    // passes no timeout): after a short wait the run ends with the exit code.
    child.once('exit', (code) => {
      // The job wrapper ended on its own (not by a stop) and reports what the CLI left running; it stopped those.
      if (child.jobReport) {
        const report = killing || stopping || settled ? null : readJobReport(child.jobReport);
        removeJobDir();
        if (report?.left?.length > 0) {
          out.leftoversStopped = report.left;
          log(`WARNING: ${command} left ${report.left.length} process(es) running (pid ${report.left.join(', ')}); its job object stopped them`);
        } else if (report?.unreadable) {
          log(`WARNING: the job report of ${command} could not be read (${report.unreadable}); whether it left a process running is not known`);
        }
      }
      if (answered || settled || stopping) return;
      exitWait = setTimeout(() => {
        // Output read after the exit may still hold the answer: then the after-answer path ends the run.
        if (settled || stopping || answered) return;
        finish({ code: code ?? 1, stopIncomplete: true, exitedOutputOpen: true });
      }, 5000);
    });
    child.on('close', (code) => {
      if (settled || stopping) return;
      settled = true;
      out.code = out.stoppedAfterAnswer && !out.timedOut ? 0 : code;
      Promise.resolve(killing).finally(() => {
        cleanup();
        resolve(out);
      });
    });
  });
}
