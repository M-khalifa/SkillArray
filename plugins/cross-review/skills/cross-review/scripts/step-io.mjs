// The output and exit seam of a pipeline step module. A step writes through io.out / io.err and ends with StepExit;
// runStep calls it in-process and returns { code, stdout, stderr, all }, the shape a child process gave before.
import { isMainModule } from './path-utils.mjs';

// A step module started with node does nothing on its own: it says so and exits 2, never a silent 0.
export function refuseDirectRun(metaUrl, name) {
  if (!isMainModule(metaUrl)) return;
  process.stderr.write(`${name}: this is a step of review-run, not a command; run node <skill-dir>/scripts/review-run.mjs --help\n`);
  process.exitCode = 2;
}

export class StepExit extends Error {
  constructor(code) {
    super(`step exit ${code}`);
    this.code = code;
  }
}

export function makeIo() {
  return { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };
}

// Runs main(argv) with io captured. main returns an exit code (or nothing for 0) or throws StepExit; any other
// error is printed as "<name>: unexpected failure: <stack>" with code 1, as the script's own entry did.
// all: both streams in the order written, as one shared file descriptor would hold them.
export async function runStep(name, io, main, argv) {
  const saved = { out: io.out, err: io.err };
  let stdout = '';
  let stderr = '';
  let all = '';
  io.out = (text) => { stdout += text; all += text; return true; };
  io.err = (text) => { stderr += text; all += text; return true; };
  let code;
  try {
    code = (await main(argv)) ?? 0;
  } catch (err) {
    if (err instanceof StepExit) code = err.code;
    else {
      const text = `${name}: unexpected failure: ${err && err.stack ? err.stack : err}\n`;
      stderr += text;
      all += text;
      code = 1;
    }
  } finally {
    io.out = saved.out;
    io.err = saved.err;
  }
  return { code, stdout, stderr, all };
}
