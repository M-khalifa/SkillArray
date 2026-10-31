// The pipeline steps are modules review-run calls in-process: none may end the process, and none is a command of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The command entries (validate-package is the maintainers' check); the seat dispatchers are the detached worker's entry.
// detach-utils holds the dispatchers' own detach and wait code, which ends the dispatcher process by design.
const ENTRIES = ['review-run.mjs', 'review-config.mjs', 'preflight.mjs', 'context-builder.mjs', 'claude-dispatch.mjs', 'codex-dispatch.mjs', 'validate-package.mjs'];
const DISPATCHER_ONLY = ['detach-utils.mjs'];
const STEPS = ['blind-relabel.mjs', 'exchange.mjs', 'build-brief.mjs', 'build-manifest.mjs', 'build-report.mjs', 'build-recheck-packet.mjs'];
const modules = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

test('no imported pipeline module calls process.exit or has a command-line entry', () => {
  const imported = modules.filter((f) => !ENTRIES.includes(f) && !DISPATCHER_ONLY.includes(f));
  assert.ok(imported.length >= 15, imported.join(', '));
  for (const f of imported) {
    const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    assert.doesNotMatch(text, /process\.exit\s*\(/, `${f} calls process.exit`);
    assert.doesNotMatch(text, /isMainModule\(import\.meta\.url\)/, `${f} has its own command-line entry`);
    assert.doesNotMatch(text, /^#!/, `${f} starts with a shebang`);
  }
});

test('a step module started with node by hand exits 2 and points at review-run, never a silent 0', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const f of STEPS) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, f), 'validate', '--phase1-dir', os.tmpdir()], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 2, `${f}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^${f.replace('.', '\\.')}: this is a step of review-run, not a command; run node <skill-dir>/scripts/review-run\\.mjs --help`), f);
    assert.equal(r.stdout, '', f);
  }
});

test('every step returns its exit code in-process: a bad argument, a missing file and a run never call process.exit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-modules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = process.exit;
  const calls = [];
  process.exit = (code) => { calls.push(code); throw new Error(`process.exit(${code}) called`); };
  try {
    const missing = path.join(dir, 'missing');
    const cases = {
      'blind-relabel.mjs': [[['bogus']], [['validate', '--phase1-dir', missing]], [['scan', '--in', missing]]],
      'exchange.mjs': [[['bogus']], [['prepare', '--run-dir', missing, '--target-dir', missing, '--tokens', 'a,b']]],
      'build-brief.mjs': [[['--mode', 'nope']], [['--mode', 'phase1', '--packet', missing, '--seat', 'A', '--out', path.join(dir, 'b.txt')]]],
      'build-manifest.mjs': [[['--bogus']], [['--run-dir', missing]]],
      'build-report.mjs': [[['--bogus']], [['--run-dir', missing]]],
      'build-recheck-packet.mjs': [[['--bogus']], [['--from-run', missing, '--out', path.join(dir, 'p.md')]]],
    };
    for (const name of STEPS) {
      const { runStep } = await import(pathToFileURL(path.join(SCRIPTS, name)).href);
      assert.equal(typeof runStep, 'function', `${name} exports runStep`);
      for (const [argv] of cases[name]) {
        const r = await runStep(argv);
        assert.notEqual(r.code, 0, `${name} ${argv.join(' ')}: ${r.stderr}`);
        assert.ok(r.stderr.length > 0, `${name} ${argv.join(' ')} says why`);
      }
    }
    // A refusal deep in a step (validate on a seat file with no fields) is its exit code 1, not an unexpected failure.
    const p1 = path.join(dir, 'phase1');
    fs.mkdirSync(p1);
    fs.writeFileSync(path.join(p1, 'A-findings.md'), '# Seat A findings\n\n## A1 — no fields\n');
    fs.writeFileSync(path.join(p1, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
    const { runStep: relabel } = await import(pathToFileURL(path.join(SCRIPTS, 'blind-relabel.mjs')).href);
    const refused = await relabel(['validate', '--phase1-dir', p1]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /claim "A1" has no recognized "Severity:" line/);
    assert.doesNotMatch(refused.stderr, /unexpected failure/);
    const { run } = await import(pathToFileURL(path.join(SCRIPTS, 'review-run.mjs')).href);
    const sink = { write: () => true };
    assert.equal(await run(['phase1', '--run-dir', missing, '--start'], { stdout: sink, stderr: sink }), 1);
    assert.equal(await run(['bogus'], { stdout: sink, stderr: sink }), 2);
  } finally {
    process.exit = real;
  }
  assert.deepEqual(calls, []);
});
