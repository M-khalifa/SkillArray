#!/usr/bin/env node
// Provider-independent benchmark orchestration: loads a labeled case, runs
// each requested arm (via an injected adapter -- bench/adapters/fake.mjs for
// tests, bench/adapters/live.mjs for real costed provider calls), writes
// per-trial artifacts, scores each arm with bench/score.mjs's scoreRun(),
// and aggregates a summary. Design: docs/design/benchmark-harness.md.
//
// Non-goals (explicit, not yet built): resume/retry of a partial run,
// parallel trial execution, automatic corpus assembly. This is a
// reproducible one-shot runner, not a scheduler.
//
// Fairness invariance (see docs/design/benchmark-harness.md and this
// session's benchmark fairness rules): each arm changes exactly one
// architectural variable relative to the others whenever practical. Any
// unavoidable deviation from that (a different task packet, a missing
// dispatcher, an injected run-directory instruction) is recorded in
// run metadata's "deviations" array, never silently absorbed.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { scoreRun } from './score.mjs';

const KNOWN_ARMS = ['claude-alone', 'codex-alone', 'union', 'skillarray'];
const KNOWN_STATUSES = ['completed', 'failed', 'timed_out', 'malformed'];

class RunComparisonError extends Error {}

function printUsageAndExit(code) {
  process.stderr.write(
    `Usage: node bench/run-comparison.mjs --case <dir> --out <dir> --adapter <fake|live>\n` +
      `  [--arms claude-alone,codex-alone,union,skillarray] [--trials N]\n\n` +
      `--case <dir>: a case directory (see bench/cases/fixture-trivial-defect/ for the shape) --\n` +
      `  must contain case.json and ground-truth.json.\n` +
      `--out <dir>: run output directory; created if missing. Each trial writes to\n` +
      `  <out>/trial-<n>/<arm>/.\n` +
      `--adapter <fake|live>: "fake" (bench/adapters/fake.mjs) never makes a real call, but has\n` +
      `  no CLI-injectable script -- it is wired programmatically from tests only, and running\n` +
      `  this CLI with --adapter fake refuses with a pointer to that. "live"\n` +
      `  (bench/adapters/live.mjs) makes real, costed provider calls and is gated the same way\n` +
      `  bench/live-smoke.mjs is (SKILLARRAY_LIVE_SMOKE=1 must be set, or this refuses to run).\n` +
      `--arms <list>: comma-separated subset of ${KNOWN_ARMS.join(', ')}. Default: all four.\n` +
      `--trials <N>: repeat each arm N times (trial-major order: all arms on trial 1, then all\n` +
      `  arms on trial 2, ...) so provider-side drift affects every arm evenly. Default: 1.\n\n` +
      `Non-goals: resume/retry of a partial run, parallel execution, automatic corpus assembly.\n`
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = { case: null, out: null, adapter: null, arms: [...KNOWN_ARMS], trials: 1 };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new RunComparisonError(`${tok} requires a value`);
      return v;
    };
    if (tok === '--case') args.case = takeValue();
    else if (tok === '--out') args.out = takeValue();
    else if (tok === '--adapter') args.adapter = takeValue();
    else if (tok === '--arms') args.arms = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
    else if (tok === '--trials') {
      const v = takeValue();
      if (!/^[1-9][0-9]*$/.test(v)) throw new RunComparisonError('--trials must be a positive integer');
      args.trials = Number(v);
    } else if (tok === '-h' || tok === '--help') printUsageAndExit(0);
    else throw new RunComparisonError(`unrecognized argument: ${tok}`);
  }
  if (!args.case) throw new RunComparisonError('--case <dir> is required');
  if (!args.out) throw new RunComparisonError('--out <dir> is required');
  if (args.adapter !== 'fake' && args.adapter !== 'live') {
    throw new RunComparisonError('--adapter must be "fake" or "live"');
  }
  for (const arm of args.arms) {
    if (!KNOWN_ARMS.includes(arm)) {
      throw new RunComparisonError(`unknown arm "${arm}"; must be one of ${KNOWN_ARMS.join(', ')}`);
    }
  }
  return args;
}

async function loadCase(caseDir) {
  const caseJsonPath = path.join(caseDir, 'case.json');
  const groundTruthPath = path.join(caseDir, 'ground-truth.json');
  let caseJson, groundTruth;
  try {
    caseJson = JSON.parse(await readFile(caseJsonPath, 'utf8'));
  } catch (err) {
    throw new RunComparisonError(`failed to read/parse "${caseJsonPath}": ${err.message}`);
  }
  try {
    groundTruth = JSON.parse(await readFile(groundTruthPath, 'utf8'));
  } catch (err) {
    throw new RunComparisonError(`failed to read/parse "${groundTruthPath}": ${err.message}`);
  }
  return { caseJson, groundTruth };
}

// Validates and normalizes whatever an adapter returned, so a malformed
// adapter result fails here with a clear message rather than propagating
// into scoreRun() and producing a confusing downstream error.
function validateArmResult(result, arm) {
  if (result === null || typeof result !== 'object') {
    throw new RunComparisonError(`adapter for arm "${arm}" returned a non-object result`);
  }
  if (!KNOWN_STATUSES.includes(result.status)) {
    throw new RunComparisonError(
      `adapter for arm "${arm}" returned unknown status "${result.status}"; must be one of ${KNOWN_STATUSES.join(', ')}`
    );
  }
  if (result.status === 'completed' && !Array.isArray(result.findings)) {
    throw new RunComparisonError(
      `adapter for arm "${arm}" returned status "completed" but findings is not an array (got ${typeof result.findings})`
    );
  }
  if (result.status !== 'completed' && result.findings !== null && result.findings !== undefined) {
    throw new RunComparisonError(
      `adapter for arm "${arm}" returned status "${result.status}" but findings is neither null nor undefined -- ` +
        `a non-completed arm must not report findings`
    );
  }
  return result;
}

async function runOneArmTrial({ runArm, arm, caseDir, packet, runDir, config, trialIndex, groundTruth }) {
  const armDir = path.join(runDir, arm);
  await mkdir(armDir, { recursive: true });

  let result;
  try {
    result = await runArm({ arm, caseDir, packet, runDir: armDir, config, trialIndex });
    result = validateArmResult(result, arm);
  } catch (err) {
    result = {
      status: 'malformed',
      findings: null,
      error: err instanceof RunComparisonError ? err.message : `adapter threw: ${err.message}`,
      usage: { source: 'unavailable' },
      artifacts: [],
      deviations: [],
    };
  }

  await writeFile(path.join(armDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');

  let score = null;
  if (result.status === 'completed') {
    try {
      score = scoreRun({ findings: result.findings, defects: groundTruth.defects ?? [] });
    } catch (err) {
      score = { error: `scoreRun failed: ${err.message}` };
    }
  }
  if (score !== null) {
    await writeFile(path.join(armDir, 'score.json'), JSON.stringify(score, null, 2) + '\n', 'utf8');
  }

  return {
    arm,
    trialIndex,
    status: result.status,
    score,
    usage: result.usage ?? { source: 'unavailable' },
    deviations: result.deviations ?? [],
  };
}

async function run(args, { runArm }) {
  const { caseJson, groundTruth } = await loadCase(args.case);
  await mkdir(args.out, { recursive: true });

  const summary = { case: caseJson.id ?? path.basename(args.case), adapter: args.adapter, trials: [] };

  // One packet per case, shared verbatim across every arm in every trial --
  // the fairness invariance rule requires the SAME task packet reach every
  // arm; "arm" is already passed to runArm as its own parameter and must not
  // also be folded into the packet an adapter forwards to a provider.
  const packet = { case: caseJson };

  // Trial-major order: all arms on trial 1, then all arms on trial 2, ...
  // so provider-side drift (a model update, a rate-limit slowdown) affects
  // every arm evenly rather than concentrating in whichever arm runs last.
  for (let trialIndex = 0; trialIndex < args.trials; trialIndex++) {
    const trialDir = path.join(args.out, `trial-${trialIndex + 1}`);
    const trialResults = [];
    for (const arm of args.arms) {
      const outcome = await runOneArmTrial({
        runArm, arm, caseDir: args.case, packet, runDir: trialDir,
        config: {}, trialIndex, groundTruth,
      });
      trialResults.push(outcome);
    }
    summary.trials.push({ trial: trialIndex + 1, arms: trialResults });
  }

  await writeFile(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) printUsageAndExit(0);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RunComparisonError) {
      process.stderr.write(`run-comparison.mjs: ${err.message}\n\n`);
      printUsageAndExit(2);
    }
    throw err;
  }

  let runArm;
  if (args.adapter === 'live') {
    if (process.env.SKILLARRAY_LIVE_SMOKE !== '1') {
      process.stderr.write(
        'run-comparison.mjs: --adapter live makes real, costed provider calls and requires ' +
          'SKILLARRAY_LIVE_SMOKE=1 to be set explicitly (same gate as bench/live-smoke.mjs) -- refusing to run.\n'
      );
      process.exit(1);
    }
    const { runArm: liveRunArm } = await import('./adapters/live.mjs');
    runArm = liveRunArm;
  } else {
    process.stderr.write(
      'run-comparison.mjs: --adapter fake requires a fake script to be wired in by the caller ' +
        '(this CLI entry point does not accept an inline script; use run() programmatically from a test).\n'
    );
    process.exit(2);
  }

  try {
    const summary = await run(args, { runArm });
    process.stdout.write(`run-comparison.mjs: done. summary written to ${path.join(args.out, 'summary.json')}\n`);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`run-comparison.mjs: ${err.message}\n`);
    process.exit(1);
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`run-comparison.mjs: unexpected failure: ${err.stack || err}\n`);
    process.exit(1);
  });
}

export { parseArgs, loadCase, validateArmResult, run, RunComparisonError, KNOWN_ARMS, KNOWN_STATUSES };
