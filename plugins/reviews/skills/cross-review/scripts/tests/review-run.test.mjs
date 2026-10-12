import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeRunDescriptor } from '../run-descriptor.mjs';
import { parseArgs, run as runInProcess, clockLine, seatRanNothing, execFailureCount, formatElapsed, seatStatusLines, otherPendingSeats, warnExtraRepos, failureDetail, tail, print } from '../review-run.mjs';
import { computeSnapshotHash } from '../preflight.mjs';
import { evaluateSupport } from '../host-support.mjs';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));
const CURRENT = path.basename(path.dirname(path.resolve(SCRIPTS)));

const COMMON = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const here = path.dirname(fileURLToPath(import.meta.url));',
  'const name = path.basename(fileURLToPath(import.meta.url));',
  'const argv = process.argv.slice(2);',
  "fs.appendFileSync(path.join(here, 'calls.log'), JSON.stringify({ script: name, argv }) + '\\n');",
  "let ctl = {}; try { ctl = JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8')); } catch { ctl = {}; }",
  'const get = (flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };',
  '',
].join('\n');

const FAKES = {
  'claude-dispatch.mjs': `
if (argv[0] === '--wait') process.exit(ctl.claudeWait ?? 0);
if (ctl.failStart) { process.stderr.write('relay: refused to start\\n'); process.exit(1); }
const brief = get('--brief');
const outDir = get('--out-dir');
const m = /^seat-([AB])$/.exec(path.basename(outDir));
const role = m ? m[1] : 'auditor';
const phase = path.basename(path.dirname(outDir));
fs.mkdirSync(outDir, { recursive: true });
if (m) fs.writeFileSync(path.join(outDir, role + (phase === 'phase1' ? '-findings.md' : '-rebuttals-raw.md')), '# findings from ' + role + '\\n');
else if (!ctl.auditorWritesNothing) fs.writeFileSync(path.join(outDir, 'findings.audit.json'), '{"fake":true}\\n');
fs.writeFileSync(path.join(path.dirname(brief), 'result.json'), JSON.stringify({
  status: 'completed', sessionId: 'sess-' + role, modelResolved: ctl.resolved && role in ctl.resolved ? ctl.resolved[role] : 'resolved-' + role, worktreePath: ctl.worktrees?.[role] ?? null,
  touchedFiles: ctl.touched && role in ctl.touched ? ctl.touched[role] : [],
}));
`,
  'codex-dispatch.mjs': `
if (argv[0] === '--wait') process.exit(ctl.codexWait ?? 0);
const brief = get('--brief');
const out = get('--final-message-out');
const role = /[\\\\/]A-(findings|rebuttals)/.test(out) ? 'A' : 'B';
const resolved = ctl.codexResolved && role in ctl.codexResolved ? ctl.codexResolved[role] : get('--model');
fs.writeFileSync(path.join(path.dirname(brief), 'result.json'), JSON.stringify({ status: 'completed', threadId: 'thread-' + role, worktreePath: null, modelResolved: resolved }));
fs.writeFileSync(out, path.basename(out) === 'findings.audit.json' ? '{"fake":true}\\n' : (role === 'B' && ctl.finalB) || '# findings from ' + role + '\\n');
`,
  'build-brief.mjs': `
if (ctl.failBuild === get('--mode')) { process.stderr.write('build-brief: refused\\n'); process.exit(1); }
fs.mkdirSync(path.dirname(get('--out')), { recursive: true });
fs.writeFileSync(get('--out'), 'brief ' + get('--mode') + '\\n');
`,
  'blind-relabel.mjs': `
const sub = argv[0];
if (sub === 'validate' && ctl.validateExit) { process.stderr.write('validate: claim A1 lacks Evidence\\n'); process.exit(ctl.validateExit); }
if (sub === 'scan' && ctl.scanExit) { process.stderr.write('scan: IDENTITY hit\\n'); process.exit(ctl.scanExit); }
if (sub === 'flip') fs.writeFileSync(get('--out'), '{"A":"X","B":"Y"}\\n');
if (sub === 'audit-prep') {
  fs.mkdirSync(get('--out-dir'), { recursive: true });
  fs.writeFileSync(path.join(get('--out-dir'), 'task-packet.md'), 'packet\\n');
  fs.writeFileSync(path.join(get('--out-dir'), 'X-findings.md'), ctl.zeroClaims ? '## No findings\\n' : '## X1\\nclaim\\n');
  fs.writeFileSync(path.join(get('--out-dir'), 'Y-findings.md'), ctl.zeroClaims ? '## No findings\\n' : '## Y1\\nclaim\\n');
  fs.mkdirSync(path.dirname(get('--breakdown-out')), { recursive: true });
  fs.writeFileSync(get('--breakdown-out'), JSON.stringify({ falsificationBreakdown: { high_or_critical: 3, disputed: ctl.qualified ?? 0, conceded: 1, unaddressed: 0 } }) + '\\n');
}
if (sub === 'translate' && ctl.translateExit) { process.stderr.write('translate: prose field contains a claim ID\\n'); process.exit(ctl.translateExit); }
if (sub === 'translate' || sub === 'scorecard') fs.writeFileSync(get('--out'), 'out\\n');
`,
  'opencode-dispatch.mjs': `
if (!ctl.opencodeSleepMs) {
  process.stderr.write('relay: refused to start\\n');
  process.exit(2);
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ctl.opencodeSleepMs);
const resultPath = path.join(path.dirname(get('--brief')), 'result.json');
if (fs.existsSync(resultPath)) {
  let n = 1;
  while (fs.existsSync(path.join(path.dirname(resultPath), 'result.attempt-' + n + '.json'))) n++;
  fs.renameSync(resultPath, path.join(path.dirname(resultPath), 'result.attempt-' + n + '.json'));
}
fs.writeFileSync(get('--final-message-out'), '# findings from B\\n');
fs.writeFileSync(resultPath, JSON.stringify({ status: 'completed', sessionId: 'sess-B', touchedFiles: [], worktreePath: null }));
process.stdout.write('relay: done.\\n');
`,
  'exchange.mjs': `
const run = get('--run-dir');
if (argv[0] === 'prepare') {
  const p2 = path.join(run, 'phase2');
  fs.mkdirSync(path.join(p2, 'B'), { recursive: true });
  const briefs = { A: path.join(p2, 'delta-brief-A.txt'), B: path.join(p2, 'B', 'delta-brief.txt') };
  for (const seat of Object.keys(briefs)) {
    if (ctl.skipped?.[seat]) briefs[seat] = null;
    else fs.writeFileSync(briefs[seat], 'delta brief\\n');
  }
  process.stdout.write(JSON.stringify({ briefs, rebuttals: { A: null, B: null }, skipped: ctl.skipped ?? {} }));
} else {
  if (ctl.finishWarning) process.stderr.write(ctl.finishWarning + String.fromCharCode(92) + 'n');
  process.stdout.write(JSON.stringify({ appended: ['A', 'B'], incomplete: [], no_peer_claims: [], concede: ctl.concede ?? 1, dispute: ctl.dispute ?? 2 }));
}
`,
};

function actor(root, role, extra = {}) {
  return {
    role, provider: 'anthropic', runtime: 'claude', model: `model-${role}`, effort: null, transport: 'cli', sessionId: null,
    outputDir: path.join(root, 'phase1', `seat-${role}`), resultPath: null, worktreePath: null, ...extra,
  };
}

class Exit extends Error {
  constructor(code) {
    super('exit');
    this.code = code;
  }
}

// Runs a fake script's body in this process, so the sequencer tests spawn almost nothing.
function inProcessRunner(hook) {
  return (name, argv) => {
    fsSync.appendFileSync(path.join(hook, 'calls.log'), JSON.stringify({ script: name, argv }) + '\n');
    let ctl = {};
    try {
      ctl = JSON.parse(fsSync.readFileSync(path.join(hook, 'control.json'), 'utf8'));
    } catch {
      ctl = {};
    }
    const get = (flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
    let stdout = '';
    let stderr = '';
    const proc = { exit: (code) => { throw new Exit(code ?? 0); }, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
    try {
      new Function('fs', 'path', 'argv', 'ctl', 'get', 'process', FAKES[name])(fsSync, path, argv, ctl, get, proc);
      return { status: 0, stdout, stderr };
    } catch (err) {
      if (err instanceof Exit) return { status: err.code, stdout, stderr };
      throw err;
    }
  };
}

async function setup(t, { skill = 'cross-review', host = 'claude-code', seatA = {}, seatB = {}, auditor = {}, flags = {}, verifiers = [], fingerprint = null, git = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'review run '));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const hook = path.join(base, 'hook');
  await fs.mkdir(hook);
  for (const [name, body] of Object.entries(FAKES)) await fs.writeFile(path.join(hook, name), COMMON + body);
  const run = path.join(base, 'run');
  const target = path.join(base, 'target');
  await fs.mkdir(run);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'file.txt'), 'content\n');
  await fs.writeFile(path.join(run, 'task-packet.md'), '# packet\n');
  if (git) {
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one']]) {
      assert.equal(spawnSync('git', args, { cwd: target }).status, 0);
    }
  }
  const desc = {
    skill, skillDir: path.join(base, skill), targetDir: target, host,
    flags: { auditDepth: 'light', falsification: false, mode: 'adversarial', ...flags }, fingerprint,
    seatA: actor(run, 'A', seatA),
    seatB: actor(run, 'B', { provider: 'openai', runtime: 'codex', model: 'gpt-5.5', ...seatB }),
    auditor: actor(run, 'auditor', { outputDir: `${run}-audit-input`, ...auditor }),
    verifiers,
  };
  desc.support = evaluateSupport(desc).map(({ role, runtime, transport, status }) => ({ role, runtime, transport, status }));
  await writeRunDescriptor(run, desc);
  const ctl = (values) => fs.writeFile(path.join(hook, 'control.json'), JSON.stringify(values));
  const state = { runAs: skill };
  const execute = (args) => {
    let out = '';
    let err = '';
    const io = { stdout: { write: (chunk) => { out += chunk; } }, stderr: { write: (chunk) => { err += chunk; } }, runner: inProcessRunner(hook), skill: state.runAs };
    return runInProcess(args, io).then((code) => ({ code, out, err }));
  };
  const rr = async (...args) => {
    const r = await execute(args);
    const lines = r.out.trim().split('\n');
    assert.ok(lines.length <= 11, `output has ${lines.length} lines:\n${r.out}`);
    assert.match(lines.at(-1), /^next: /, `the last line is the next: line:\n${r.out}`);
    return { code: r.code, lines, out: r.out, err: r.err };
  };
  const calls = async () => (await fs.readFile(path.join(hook, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const flag = (call, name) => call.argv[call.argv.indexOf(name) + 1];
  return { base, run, target, hook, desc, ctl, rr, calls, flag, state };
}

const names = (calls) => calls.map((c) => `${c.script.replace('.mjs', '')}:${c.script.endsWith('dispatch.mjs') && c.argv.includes('--detach') ? 'start' : c.argv[0]}`);

test('parseArgs: exactly one half per command, and the half names differ for audit', () => {
  assert.deepEqual(parseArgs(['phase1', '--run-dir', 'r', '--start']), { command: 'phase1', runDir: 'r', half: 'start', maxWait: 480, nativeDone: [], nativeAgents: {}, acceptMissingVerifiers: false, auditDepth: null, local: false });
  assert.equal(parseArgs(['audit', '--run-dir', 'r', '--finish', '--max-wait', '5']).maxWait, 5);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r']), /needs one of/);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--start', '--wait']), /exactly one/);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--prepare']), /unrecognized/);
  assert.throws(() => parseArgs(['audit', '--run-dir', 'r', '--start']), /unrecognized/);
  assert.throws(() => parseArgs(['phase3', '--run-dir', 'r', '--start']), /first argument/);
  assert.throws(() => parseArgs(['phase1', '--start']), /--run-dir is required/);
});

test('an argument error exits 2 and still ends with a next: line', async (t) => {
  const s = await setup(t);
  const r = await s.rr('phase1', '--run-dir', s.run);
  assert.equal(r.code, 2);
  assert.match(r.err, /needs one of --start \/ --wait/);
});

test('phase1 --start builds both briefs from run.json, starts the CLI seats detached and reports one next: line', async (t) => {
  const s = await setup(t);
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 0, r.out + r.err);
  const calls = await s.calls();
  assert.deepEqual(names(calls), ['build-brief:--mode', 'claude-dispatch:start', 'build-brief:--mode', 'codex-dispatch:start']);
  const [briefA, startA, briefB, startB] = calls;
  assert.equal(s.flag(briefA, '--channel'), 'file');
  assert.equal(s.flag(briefA, '--output-path'), path.join(s.run, 'phase1', 'seat-A', 'A-findings.md'));
  assert.equal(s.flag(briefB, '--channel'), 'final-message');
  assert.equal(briefB.argv.includes('--output-path'), false);
  assert.equal(s.flag(startA, '--out-dir'), path.join(s.run, 'phase1', 'seat-A'));
  assert.equal(s.flag(startA, '--model'), 'model-A');
  assert.ok(startA.argv.includes('--web') && startA.argv.includes('--detach'));
  assert.equal(s.flag(startB, '--final-message-out'), path.join(s.run, 'phase1', 'B-findings.md'));
  assert.equal(s.flag(startB, '--sandbox'), 'read-only');
  assert.match(r.lines.at(-1), /^next: .*review-run phase1 --run-dir .* --wait$/);
});

test('phase1 --start for a native seat prints its brief path and starts nothing for it', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.some((l) => l.startsWith('seat A: native') && l.includes(path.join(s.run, 'phase1', 'brief-A.txt'))));
  const briefA = (await s.calls())[0];
  assert.equal(s.flag(briefA, '--output-path'), path.join(s.run, 'phase1', 'A-findings.md'));
  assert.deepEqual(names(await s.calls()), ['build-brief:--mode', 'build-brief:--mode', 'codex-dispatch:start']);
});

test('phase1 --start with a repo-only run leaves web out of the briefs and the dispatch', async (t) => {
  const s = await setup(t, { flags: { repoOnly: true } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const calls = await s.calls();
  assert.ok(calls[0].argv.includes('--repo-only'));
  assert.equal(calls[1].argv.includes('--web'), false);
  assert.equal(calls[3].argv.includes('--web'), false);
});

test('phase1 start then wait: publishes the file-channel seat, validates, and the whole path runs the documented scripts in order', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(await fs.readFile(path.join(s.run, 'phase1', 'A-findings.md'), 'utf8'), '# findings from A\n');
  assert.equal(await fs.readFile(path.join(s.run, 'phase1', 'B-findings.md'), 'utf8'), '# findings from B\n');
  const wait = (await s.calls()).slice(4);
  assert.deepEqual(names(wait), ['claude-dispatch:--wait', 'codex-dispatch:--wait', 'blind-relabel:validate']);
  assert.equal(s.flag(wait[2], '--phase1-dir'), path.join(s.run, 'phase1'));
  assert.equal(s.flag(wait[2], '--packet'), path.join(s.run, 'task-packet.md'));
  assert.ok(r.lines.some((l) => /published A-findings\.md/.test(l)));
  assert.match(r.lines.at(-1), /^next: run: review-run phase2 --run-dir .* --start$/);
  const again = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(again.code, 0, 'a second --wait republishes nothing and still passes');
});

test('the sequencer stops at the first failed step, names it, runs nothing after it and keeps every artifact', async (t) => {
  const s = await setup(t);
  await s.ctl({ failBuild: 'phase1' });
  const failed = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(failed.code, 1);
  assert.match(failed.lines.at(-2), /^FAILED build seat A brief: build-brief\.mjs exited 1: build-brief: refused/);
  assert.match(failed.lines.at(-1), /^next: fix "build seat A brief" .* then rerun: review-run phase1 --run-dir .* --start$/);
  assert.deepEqual(names(await s.calls()), ['build-brief:--mode'], 'seat B is never started after seat A failed');

  await s.ctl({});
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await s.ctl({ validateExit: 1 });
  const invalid = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(invalid.code, 1);
  assert.match(invalid.lines.at(-2), /^FAILED validate Phase 1: blind-relabel\.mjs exited 1: validate: claim A1 lacks Evidence/);
  assert.equal((await fs.readFile(path.join(s.run, 'phase1', 'A-findings.md'), 'utf8')).length > 0, true, 'the published file stays in place');

  await s.ctl({ claudeWait: 1 });
  await fs.rm(path.join(s.run, 'phase1', 'A-findings.md'));
  const dead = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(dead.code, 1);
  assert.match(dead.lines.at(-2), /^FAILED wait seat A: /);
});

test('a dispatcher that refuses to start fails the step with its own message', async (t) => {
  const s = await setup(t);
  await s.ctl({ failStart: true });
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-2), /^FAILED start seat A: claude-dispatch\.mjs exited 1: relay: refused to start/);
});

test('a seat still running after the wait window exits 3 with a rerun line', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await s.ctl({ claudeWait: 3 });
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(r.code, 3);
  assert.match(r.lines.at(-1), /^next: seat A \(claude\) is still running; rerun this command: review-run phase1 --run-dir .* --wait$/);
});

test('a native seat is waited for by its output file and a missing file exits 3', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const waiting = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3);
  assert.match(waiting.lines.at(-1), /native seat A has not written .*A-findings\.md/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
});

test('a native seat whose Phase 1 file holds only the header is still running: exit 3, no validate', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n');
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(r.code, 3, r.out);
  assert.match(r.lines.at(-1), /seat A: .*A-findings\.md has no claims yet, the agent may still be running; if it already replied "written", the file is malformed: return it to the seat \(do not hand-edit\)/);
  assert.equal(r.lines.some((l) => l.includes('output found (native)')), false);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs'), false, 'validate must not run');
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 - x\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
});

test('a native seat with a claim in its file is not done until --native-done names it: exit 3 and no validate', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 - partial\nclaim\n');
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(r.code, 3, r.out);
  assert.match(r.lines.at(-1), /seat A is native: .*A-findings\.md exists but a file alone cannot show the agent finished.*rerun this command with --native-done A/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs'), false, 'validate must not run');
  const wrongSeat = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'B');
  assert.equal(wrongSeat.code, 3, wrongSeat.out);
  const done = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A');
  assert.equal(done.code, 0, done.out);
  assert.equal(done.lines.some((l) => l.includes('output found (native, agent reported done)')), true);
});

test('--native-done rejects an empty list and an unknown seat letter', () => {
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--wait', '--native-done', 'C']), /--native-done takes seat letters/);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--wait', '--native-done', ',']), /--native-done takes seat letters/);
  assert.deepEqual(parseArgs(['phase1', '--run-dir', 'r', '--wait', '--native-done', 'A,B']).nativeDone, ['A', 'B']);
});

test('a native seat with the No findings marker is finished; a peer-letter heading is not a claim for this seat', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## B1 - wrong letter\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1')).code, 3);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## No findings\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
});

test('a native seat in Phase 2 is finished only with a ### P block; a header-only file exits 3', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1 - x\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const file = path.join(s.run, 'phase2', 'A-rebuttals-raw.md');
  await fs.writeFile(file, '## Rebuttals (from A) of B claims\n');
  const waiting = await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3, waiting.out);
  assert.match(waiting.lines.at(-1), /A-rebuttals-raw\.md has no claims yet, the agent may still be running/);
  assert.equal((await s.calls()).some((c) => c.script === 'exchange.mjs' && c.argv[0] === 'finish'), false);
  await fs.writeFile(file, '## Rebuttals (from A) of B claims\n\n### P1\nCONCEDE\n');
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
});

test('pair-review distinctness: equal init ids stop the wait, distinct ids pass [slow]', async (t) => {
  for (const [resolved, code] of [[{ A: 'same-id', B: 'SAME-ID' }, 1], [{ A: 'id-one', B: 'id-two' }, 0]]) {
    const s = await setup(t, { skill: 'pair-review', seatB: { provider: 'anthropic', runtime: 'claude', model: 'model-B' } });
    await s.ctl({ resolved });
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
    assert.equal(r.code, code, r.out + r.err);
    if (code === 1) assert.match(r.lines.at(-2), /^FAILED distinct models: both seats ran same-id \(init model id\)/);
    else assert.ok(r.lines.includes('models distinct: init ids differ'));
    assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs'), code === 0, 'validate runs only after the distinctness check');
  }
});

test('pair-review with native seats compares the requested ids and records family-distinct', async (t) => {
  const make = (modelB) => setup(t, {
    skill: 'pair-review',
    seatA: { transport: 'native' },
    seatB: { provider: 'anthropic', runtime: 'claude', transport: 'native', model: modelB },
  });
  await assert.rejects(make('model-A'), /distinct/, 'equal requested ids are refused when run.json is written');
  for (const [modelB, code] of [['model-B', 0]]) {
    const s = await make(modelB);
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    for (const role of ['A', 'B']) await fs.writeFile(path.join(s.run, 'phase1', `${role}-findings.md`), `## ${role}1\nclaim\n`);
    const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A,B');
    assert.equal(r.code, code, r.out);
    if (code === 1) assert.match(r.lines.at(-2), /both seats ran model-A \(requested id\)/);
    else assert.ok(r.lines.includes('models distinct: requested ids differ; effective distinctness unverified (recorded family-distinct)'));
  }
});

const OPENAI_PAIR = {
  skill: 'pair-review',
  seatA: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-sol' },
  seatB: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-terra' },
  auditor: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-sol' },
};

test('an OpenAI pair-review runs both seats through codex-dispatch, read-only, and compares the rollout model ids', async (t) => {
  for (const [codexResolved, code] of [[{ A: 'gpt-5.6-sol', B: 'gpt-5.6-terra' }, 0], [{ A: 'gpt-5.6-sol', B: 'GPT-5.6-SOL' }, 1]]) {
    const s = await setup(t, OPENAI_PAIR);
    await s.ctl({ codexResolved });
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    const starts = (await s.calls()).filter((c) => c.script === 'codex-dispatch.mjs' && c.argv.includes('--detach'));
    assert.deepEqual(starts.map((c) => s.flag(c, '--model')).sort(), ['gpt-5.6-sol', 'gpt-5.6-terra']);
    for (const c of starts) assert.equal(s.flag(c, '--sandbox'), 'read-only');
    assert.equal((await s.calls()).some((c) => c.script === 'claude-dispatch.mjs'), false, 'no Claude dispatcher runs');
    const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
    assert.equal(r.code, code, r.out + r.err);
    if (code === 0) assert.ok(r.lines.includes('models distinct: init ids differ'));
    else assert.match(r.lines.at(-2), /^FAILED distinct models: both seats ran gpt-5\.6-sol \(init model id\)/);
  }
});

test('an OpenAI pair-review seat whose result has no model id stops the wait: distinct models cannot be shown', async (t) => {
  const s = await setup(t, OPENAI_PAIR);
  await s.ctl({ codexResolved: { A: 'gpt-5.6-sol', B: '' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED distinct models: seat B has no init model id/);
});

test('audit --finish with a Codex auditor: final-message brief, read-only codex-dispatch writing findings.audit.json, then translate', async (t) => {
  const s = await prepared(t, OPENAI_PAIR);
  const before = (await s.calls()).length;
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 0, r.out + r.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls), ['build-brief:--mode', 'codex-dispatch:start', 'codex-dispatch:--wait', 'blind-relabel:translate', 'blind-relabel:scorecard', 'blind-relabel:clear-cache']);
  const [brief, dispatch] = calls;
  assert.equal(s.flag(brief, '--channel'), 'final-message');
  assert.equal(brief.argv.includes('--output-path'), false, 'a final-message brief has no --output-path');
  assert.equal(s.flag(dispatch, '--sandbox'), 'read-only');
  assert.equal(s.flag(dispatch, '--model'), 'gpt-5.6-sol');
  assert.equal(s.flag(dispatch, '--final-message-out'), path.join(`${s.run}-audit-input`, 'findings.audit.json'));
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"fake":true}\n');
});

test('phase2 --start runs exchange prepare, resumes every CLI seat on its Phase 1 session and phase2 --wait runs exchange finish', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const before = (await s.calls()).length;
  const start = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.equal(start.code, 0, start.out + start.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls), ['exchange:prepare', 'claude-dispatch:start', 'codex-dispatch:start']);
  assert.equal(s.flag(calls[0], '--tokens'), 'model-A,gpt-5.5');
  assert.equal(s.flag(calls[1], '--session'), 'sess-A');
  assert.equal(s.flag(calls[1], '--brief'), path.join(s.run, 'phase2', 'A', 'delta-brief.txt'));
  assert.equal(s.flag(calls[1], '--out-dir'), path.join(s.run, 'phase2', 'seat-A'));
  assert.equal(s.flag(calls[2], '--session'), 'thread-B');
  assert.equal(s.flag(calls[2], '--previous-result'), path.join(s.run, 'phase1', 'B', 'result.json'));
  assert.equal(s.flag(calls[2], '--final-message-out'), path.join(s.run, 'phase2', 'B-rebuttals-raw.md'));
  assert.equal(calls[2].argv.includes('--sandbox'), false, 'a resume does not pass --sandbox');
  const wait = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(wait.code, 0, wait.out + wait.err);
  assert.deepEqual(names((await s.calls()).slice(before + 3)), ['claude-dispatch:--wait', 'codex-dispatch:--wait', 'exchange:finish']);
  assert.ok(wait.lines.some((l) => /exchange finish: done \(appended A,B; concede 1, dispute 2\)/.test(l)));
});

test('phase2 skips a seat whose peer had nothing to rebut and does not wait for it', async (t) => {
  const s = await setup(t);
  await s.ctl({ skipped: { A: 'seat B has no findings' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const start = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(start.lines.some((l) => l.startsWith('seat A: skipped')));
  const before = (await s.calls()).length;
  const wait = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(wait.code, 0, wait.out);
  const waits = (await s.calls()).slice(before).filter((c) => c.argv[0] === '--wait');
  assert.deepEqual(waits.map((c) => c.script), ['codex-dispatch.mjs']);
});

test('pair-review mode none skips Phase 2 entirely and audit-prep gets no --phase2-dir', async (t) => {
  const s = await setup(t, { skill: 'pair-review', flags: { mode: 'none' }, seatB: { provider: 'anthropic', runtime: 'claude', model: 'model-B' } });
  for (const half of ['--start', '--wait']) {
    const r = await s.rr('phase2', '--run-dir', s.run, half);
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'mode none: Phase 2 skipped, no exchange');
    assert.match(r.lines.at(-1), /^next: run: review-run audit --run-dir .* --prepare$/);
  }
  assert.deepEqual(await s.calls(), [], 'no script ran for Phase 2');
  const prep = await s.rr('audit', '--run-dir', s.run, '--prepare');
  assert.equal(prep.code, 0, prep.out + prep.err);
  const auditPrep = (await s.calls()).find((c) => c.argv[0] === 'audit-prep');
  assert.equal(auditPrep.argv.includes('--phase2-dir'), false);
});

test('audit --prepare flips once, stages the auditor folder outside the run directory, prints the qualified claim count and stops', async (t) => {
  const s = await setup(t, { flags: { falsification: true } });
  await s.ctl({ qualified: 2 });
  const r = await s.rr('audit', '--run-dir', s.run, '--prepare');
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(names(await s.calls()), ['blind-relabel:flip', 'blind-relabel:audit-prep']);
  const prep = (await s.calls())[1];
  assert.equal(s.flag(prep, '--out-dir'), `${s.run}-audit-input`);
  assert.equal(s.flag(prep, '--mapping'), path.join(s.run, 'phase3-private', 'seat-to-audit-label.json'));
  assert.equal(s.flag(prep, '--breakdown-out'), path.join(s.run, 'phase3', 'falsification-breakdown.json'));
  assert.ok(r.lines.includes('falsification: requested; qualified claims: 2'));
  assert.match(r.lines.at(-1), /^next: run 2 verifier\(s\) .*then run: review-run audit --run-dir .* --finish$/);
  const again = await s.rr('audit', '--run-dir', s.run, '--prepare');
  assert.equal(again.code, 1, 'a second prepare finds the staged folder non-empty');
  assert.match(again.lines.at(-2), /^FAILED audit-prep: .* is not empty/);
  assert.ok(again.lines.includes('flip: kept the earlier coin flip'));
});

async function prepared(t, options) {
  const s = await setup(t, options);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  return s;
}

test('audit --finish with a CLI auditor: brief with the requested depth, dispatch, translate, scorecard, clear-cache, in the documented order', async (t) => {
  const s = await prepared(t, { flags: { auditDepth: 'full', falsification: true } });
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const before = (await s.calls()).length;
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 0, r.out + r.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls), ['blind-relabel:scan', 'build-brief:--mode', 'claude-dispatch:start', 'claude-dispatch:--wait', 'blind-relabel:translate', 'blind-relabel:scorecard', 'blind-relabel:clear-cache']);
  const [, brief, dispatch, , translate] = calls;
  assert.equal(s.flag(brief, '--mode'), 'auditor');
  assert.equal(s.flag(brief, '--audit-depth'), 'full', 'the requested depth reaches the auditor brief');
  assert.equal(s.flag(brief, '--out'), path.join(`${s.run}-audit-dispatch`, 'auditor-brief.txt'));
  assert.equal(s.flag(brief, '--output-path'), path.join(`${s.run}-audit-input`, 'findings.audit.json'));
  assert.equal(s.flag(brief, '--run-dir'), s.run);
  assert.equal(await fs.readFile(path.join(`${s.run}-audit-input`, 'verification-X1.md'), 'utf8'), 'verified\n', 'verification files are staged before the brief is built');
  assert.equal(s.flag(dispatch, '--out-dir'), `${s.run}-audit-input`);
  assert.equal(s.flag(translate, '--audit-depth'), 'full');
  assert.equal(s.flag(translate, '--verification-dir'), path.join(s.run, 'phase3'));
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"fake":true}\n');
  assert.match(r.lines.at(-1), /^next: write the manifest/);
});

test('audit --finish after a refused translate and a corrected auditor file keeps the refused copy and continues', async (t) => {
  const s = await prepared(t);
  await s.ctl({ translateExit: 1 });
  const refused = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.lines.join('\n'), /FAILED translate/);
  const auditFile = path.join(s.run, 'phase3', 'findings.audit.json');
  assert.equal(await fs.readFile(auditFile, 'utf8'), '{"fake":true}\n');
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"corrected":true}\n');
  await s.ctl({});
  const dispatches = (await s.calls()).filter((c) => c.script === 'claude-dispatch.mjs').length;
  const done = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal((await s.calls()).filter((c) => c.script === 'claude-dispatch.mjs').length, dispatches, 'the auditor is not dispatched again');
  assert.equal(await fs.readFile(auditFile, 'utf8'), '{"corrected":true}\n');
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.attempt-1.json'), 'utf8'), '{"fake":true}\n');
  assert.ok(done.lines.some((l) => /findings\.audit\.attempt-1\.json/.test(l)));
});

test('audit --finish without falsification passes no --verification-dir and keeps the light depth [slow]', async (t) => {
  const s = await prepared(t);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  const calls = await s.calls();
  const translate = calls.find((c) => c.argv[0] === 'translate');
  assert.equal(translate.argv.includes('--verification-dir'), false);
  assert.equal(s.flag(translate, '--audit-depth'), 'light');
});

test('audit --finish with a native auditor builds the brief in the staged folder and waits for the auditor output', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  const first = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(first.code, 0, first.out + first.err);
  assert.equal(s.flag((await s.calls()).find((c) => c.script === 'build-brief.mjs'), '--out'), path.join(`${s.run}-audit-input`, 'auditor-brief.txt'));
  assert.ok(first.lines.some((l) => l.startsWith('auditor: native; spawn it with brief')));
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false);
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"native":true}\n');
  const second = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal((await s.calls()).filter((c) => c.script === 'build-brief.mjs').length, 1, 'the brief is not rebuilt on the rerun');
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"native":true}\n');
});

test('audit --finish refuses a CLI auditor when the target no longer matches the Phase 1 fingerprint', async (t) => {
  const s = await prepared(t, { fingerprint: { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: 'not-the-current-hash' } });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-2), /^FAILED fingerprint: the target no longer matches/);
  assert.equal((await s.calls()).some((c) => c.script === 'build-brief.mjs'), false);
});

test('audit --finish removes every actor worktree named in the result files and prunes [slow]', async (t) => {
  const s = await setup(t, { git: true, auditor: { transport: 'native' } });
  const wt = (name) => path.join(s.base, `wt-${name}`);
  const names4 = ['seat-a-p1', 'seat-b-p1', 'seat-a-p2', 'auditor'];
  for (const name of names4) {
    assert.equal(spawnSync('git', ['worktree', 'add', '--detach', wt(name)], { cwd: s.target }).status, 0);
    await fs.writeFile(`${wt(name)}.snapshot-complete`, 'ok');
  }
  const put = async (dir, name, file = 'result.json') => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), JSON.stringify({ status: 'completed', worktreePath: wt(name) }));
  };
  await put(path.join(s.run, 'phase1', 'A'), 'seat-a-p1');
  await put(path.join(s.run, 'phase1', 'B'), 'seat-b-p1');
  await put(path.join(s.run, 'phase2', 'A'), 'seat-a-p2');
  await put(`${s.run}-audit-dispatch`, 'auditor');
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{}');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.includes('worktrees: removed 4'));
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: s.target, encoding: 'utf8' }).stdout;
  assert.equal(listed.split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'only the main worktree is left');
  for (const name of names4) {
    await assert.rejects(fs.access(wt(name)));
    await assert.rejects(fs.access(`${wt(name)}.snapshot-complete`));
  }
});

test('a run.json made for the other skill is refused', async (t) => {
  const s = await setup(t);
  s.state.runAs = 'pair-review';
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-2), /^FAILED run\.json: run\.json was made for cross-review, but this is pair-review/);
});

test('a missing run.json fails the run.json step', async (t) => {
  const s = await setup(t);
  await fs.rm(path.join(s.run, 'run.json'));
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-2), /^FAILED run\.json: cannot read run descriptor/);
});

test('the CLI itself runs the sequencer through the REVIEW_RUN_SCRIPTS_DIR hook with real child processes [slow]', async (t) => {
  const pair = CURRENT === 'pair-review';
  const s = await setup(t, { skill: CURRENT, ...(pair ? { seatB: { provider: 'anthropic', runtime: 'claude', model: 'model-B' } } : {}) });
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'review-run.mjs'), 'phase1', '--run-dir', s.run, '--start'], {
    encoding: 'utf8', env: { ...process.env, REVIEW_RUN_SCRIPTS_DIR: s.hook },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines.at(-1), /^next: run: review-run phase1 --run-dir .* --wait$/);
  assert.deepEqual(names(await s.calls()), ['build-brief:--mode', 'claude-dispatch:start', 'build-brief:--mode', pair ? 'claude-dispatch:start' : 'codex-dispatch:start']);
});

const auditDir = (s) => `${s.run}-audit-dispatch`;
const auditOut = (s) => path.join(`${s.run}-audit-input`, 'findings.audit.json');
const dispatches = async (s) => (await s.calls()).filter((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach'));

async function auditorWithBrief(t, result, { output = true, ...options } = {}) {
  const s = await prepared(t, options);
  await fs.mkdir(auditDir(s), { recursive: true });
  await fs.writeFile(path.join(auditDir(s), 'auditor-brief.txt'), 'brief auditor\n');
  if (result) await fs.writeFile(path.join(auditDir(s), 'result.json'), JSON.stringify(result));
  if (output) await fs.writeFile(auditOut(s), '{"preliminary":true}\n');
  return s;
}

test('F2: an existing auditor output is not consumed while the CLI auditor still runs', async (t) => {
  const s = await auditorWithBrief(t, { status: 'running' });
  await s.ctl({ claudeWait: 3 });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.lines.at(-1), /^next: the auditor is still running/);
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false, 'nothing is translated from a running auditor');
  assert.equal((await s.calls()).some((c) => c.script === 'claude-dispatch.mjs' && c.argv[0] === '--wait'), true);
});

test('F2: a CLI auditor output with no result.json to prove completion is refused', async (t) => {
  const s = await auditorWithBrief(t, null);
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED auditor output: .*no result\.json/);
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false);
});

test('F11: a failed CLI auditor is dispatched again by the rerun, with or without a leftover output file', async (t) => {
  for (const output of [false, true]) {
    const s = await auditorWithBrief(t, { status: 'error', error: 'boom' }, { output });
    const r = await s.rr('audit', '--run-dir', s.run, '--finish');
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal((await dispatches(s)).length, 1, 'the auditor is dispatched once more');
    assert.ok(r.lines.some((l) => /^auditor: previous attempt ended with status error; dispatched again/.test(l)), r.out);
    assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"fake":true}\n', 'the new output is the one translated');
  }
});

test('F11: a failed CLI auditor wait names the rerun that dispatches it again', async (t) => {
  const s = await prepared(t);
  await s.ctl({ claudeWait: 1 });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-2), /^FAILED auditor wait: .*rerunning this command dispatches the auditor again/);
});

test('F11: a failed CLI seat is dispatched again by the phase wait rerun', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'error', error: 'boom' }));
  await fs.rm(path.join(s.run, 'phase1', 'seat-A', 'A-findings.md'));
  const before = (await s.calls()).length;
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 0, r.out + r.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls).slice(0, 2), ['claude-dispatch:start', 'claude-dispatch:--wait']);
  assert.equal(s.flag(calls[0], '--brief'), path.join(s.run, 'phase1', 'A', 'brief.txt'));
  assert.ok(r.lines.some((l) => /^seat A: previous attempt ended with status error; dispatched again/.test(l)), r.out);
});

test('F3: the drift refusal also runs on an auditor retry that finds its brief already built', async (t) => {
  const s = await auditorWithBrief(t, null, { output: false, fingerprint: { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: 'not-the-current-hash' } });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED fingerprint: the target no longer matches/);
  assert.equal((await dispatches(s)).length, 0, 'no auditor is dispatched against a changed target');
});

test('F4: a seat that wrote into the target fails the Phase 1 wait; an unavailable inventory is printed', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'completed', sessionId: 'sess-A', touchedFiles: ['src/app.js'] }));
  const bad = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.lines.at(-2), /^FAILED seat A touched files: .*src\/app\.js/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'completed', sessionId: 'sess-A', touchedFiles: null }));
  const unknown = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(unknown.code, 0, unknown.out);
  assert.ok(unknown.lines.some((l) => /^seat A: completed .*touchedFiles unavailable/.test(l)), unknown.out);
});

test('F4: a seat that wrote into the target fails the Phase 2 wait', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase2', 'A', 'result.json'), JSON.stringify({ status: 'completed', touchedFiles: ['x.js'] }));
  const r = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-2), /^FAILED seat A touched files: .*x\.js/);
});

test('F4: an auditor that wrote into the target fails the finish step before translate', async (t) => {
  const s = await prepared(t);
  await s.ctl({ touched: { auditor: ['src/app.js'] } });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-2), /^FAILED auditor touched files: .*src\/app\.js/);
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false);
});

test('F4: the target fingerprint is checked again before translate', async (t) => {
  const { computeSnapshotHash } = await import('../preflight.mjs');
  const s = await prepared(t, { auditor: { transport: 'native' } });
  s.desc.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(s.target) };
  await fs.rm(path.join(s.run, 'run.json'));
  await writeRunDescriptor(s.run, s.desc);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 0, 'the first finish builds the brief and waits for the native auditor');
  await fs.writeFile(path.join(s.target, 'file.txt'), 'changed while the auditor ran\n');
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-2), /^FAILED fingerprint: /);
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false);
});

test('F1: only verification-<anonymous id>.md files that match a staged claim are staged, and each is scanned [slow]', async (t) => {
  const stage = async (name, options = {}) => {
    const s = await prepared(t, { flags: { falsification: true } });
    await fs.writeFile(path.join(s.run, 'phase3', name), 'verified\n');
    if (options.scanExit) await s.ctl({ scanExit: options.scanExit });
    return { s, r: await s.rr('audit', '--run-dir', s.run, '--finish') };
  };
  const real = await stage('verification-A1.md');
  assert.equal(real.r.code, 1, real.r.out);
  assert.match(real.r.lines.at(-2), /^FAILED stage verification: verification-A1\.md is not named for an anonymous claim ID/);
  const unknown = await stage('verification-X9.md');
  assert.equal(unknown.r.code, 1, unknown.r.out);
  assert.match(unknown.r.lines.at(-2), /^FAILED stage verification: verification-X9\.md names X9, which is not a claim in the staged findings/);
  const leaky = await stage('verification-X1.md', { scanExit: 1 });
  assert.equal(leaky.r.code, 1, leaky.r.out);
  assert.match(leaky.r.lines.at(-2), /^FAILED stage verification: .*blind-relabel\.mjs exited 1: scan: IDENTITY hit/);
  await assert.rejects(fs.access(path.join(`${leaky.s.run}-audit-input`, 'verification-X1.md')), 'a file that failed the scan is not copied');
  const ok = await stage('verification-Y1.md');
  assert.equal(ok.r.code, 0, ok.r.out);
  const scan = (await ok.s.calls()).find((c) => c.argv[0] === 'scan');
  assert.equal(ok.s.flag(scan, '--in'), path.join(ok.s.run, 'phase3', 'verification-Y1.md'));
  assert.equal(ok.s.flag(scan, '--tokens'), 'model-A,gpt-5.5');
});

test('F5: two CLI seats need two distinct init model ids; a missing id is a failure, not a fallback', async (t) => {
  const s = await setup(t, { skill: 'pair-review', seatB: { provider: 'anthropic', runtime: 'claude', model: 'model-B' } });
  await s.ctl({ resolved: { A: null } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-2), /^FAILED distinct models: .*init model id/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs'), false);
});

test('F9: an OpenCode dispatcher that exits without a result.json fails the wait instead of running forever [slow]', async (t) => {
  const previous = process.env.REVIEW_RUN_SCRIPTS_DIR;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_RUN_SCRIPTS_DIR; else process.env.REVIEW_RUN_SCRIPTS_DIR = previous; });
  const s = await setup(t, { seatA: { transport: 'native' }, seatB: { provider: 'opencode', runtime: 'opencode', model: 'opencode/fake' } });
  process.env.REVIEW_RUN_SCRIPTS_DIR = s.hook;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  for (let i = 0; i < 100 && !(await s.calls()).some((c) => c.script === 'opencode-dispatch.mjs'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const workerLog = path.join(s.run, 'phase1', 'B', 'dispatch-worker.log');
  for (let i = 0; i < 300; i++) {
    const log = await fs.readFile(workerLog, 'utf8').catch(() => '');
    if (log.includes('refused to start')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-done', 'A');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-2), /^FAILED wait seat B: the opencode dispatcher \(pid \d+\) exited without writing a result\.json: relay: refused to start/);
});

test('F10: audit finish removes a CLI verifier worktree found in the verifier output folder [slow]', async (t) => {
  const s = await setup(t, { git: true, auditor: { transport: 'native' } });
  const folder = path.join(s.run, 'phase3', 'verifier-1');
  s.desc.verifiers = [{
    role: 'verifier-1', provider: 'anthropic', runtime: 'claude', model: 'model-V', effort: null, transport: 'cli', sessionId: null,
    outputDir: folder, resultPath: null, worktreePath: null,
  }];
  await fs.rm(path.join(s.run, 'run.json'));
  await writeRunDescriptor(s.run, s.desc);
  const wt = path.join(s.base, 'wt-verifier');
  assert.equal(spawnSync('git', ['worktree', 'add', '--detach', wt], { cwd: s.target }).status, 0);
  await fs.writeFile(`${wt}.snapshot-complete`, 'ok');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify({ status: 'completed', worktreePath: wt }));
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.writeFile(auditOut(s), '{}');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.includes('worktrees: removed 1'), r.out);
  await assert.rejects(fs.access(wt));
  await assert.rejects(fs.access(`${wt}.snapshot-complete`));
});

// Runs the fake scripts in-process except blind-relabel, which is the real scanner.
function realScanRunner(hook) {
  const fake = inProcessRunner(hook);
  return (name, argv) => {
    if (name !== 'blind-relabel.mjs' || argv[0] !== 'scan') return fake(name, argv);
    fsSync.appendFileSync(path.join(hook, 'calls.log'), JSON.stringify({ script: name, argv }) + '\n');
    return spawnSync(process.execPath, [path.join(SCRIPTS, 'blind-relabel.mjs'), ...argv], { encoding: 'utf8' });
  };
}

async function finishWithRealScan(s, io = {}) {
  let out = '';
  let err = '';
  const code = await runInProcess(['audit', '--run-dir', s.run, '--finish'], {
    stdout: { write: (c) => { out += c; } }, stderr: { write: (c) => { err += c; } }, runner: realScanRunner(s.hook), skill: s.state.runAs, ...io,
  });
  return { code, out, err, lines: out.trim().split('\n') };
}

async function stageRealScanRun(t, evidence, options = {}) {
  const s = await prepared(t, { flags: { falsification: true }, ...options });
  await fs.mkdir(path.join(s.run, 'phase1'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim a\n');
  await fs.writeFile(path.join(s.run, 'phase1', 'B-findings.md'), '## B1\nclaim b\n');
  await fs.mkdir(path.join(s.run, 'phase2'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase2', 'peer-view-for-A.md'), '## P1\nx\n');
  await fs.writeFile(path.join(s.run, 'phase2', 'peer-view-for-B.md'), '## P1\nx\n');
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), `Verdict: confirmed.\n\n${evidence}\n`);
  return s;
}

test('R2-F3: a verification file that cites a real seat claim ID is stopped by the real scanner and never staged', async (t) => {
  const s = await stageRealScanRun(t, 'Evidence: matches what the first reviewer said in A1.');
  const r = await finishWithRealScan(s);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED stage verification: .*1 real claim-ID leak/);
  await assert.rejects(fs.access(path.join(`${s.run}-audit-input`, 'verification-X1.md')), 'a leaking file is not copied to the auditor folder');
});

test('R2-F3: the verification scan gets the Phase 1 dir, both seats and the Phase 2 dir; a clean file is staged', async (t) => {
  const s = await stageRealScanRun(t, 'Evidence: the code at file.txt line 1 shows the defect.');
  const r = await finishWithRealScan(s);
  assert.equal(r.code, 0, r.out + r.err);
  const scan = (await s.calls()).find((c) => c.argv[0] === 'scan');
  assert.equal(s.flag(scan, '--phase1-dir'), path.join(s.run, 'phase1'));
  assert.equal(s.flag(scan, '--forbid-seats'), 'A,B');
  assert.equal(s.flag(scan, '--phase2-dir'), path.join(s.run, 'phase2'));
  assert.equal(await fs.readFile(path.join(`${s.run}-audit-input`, 'verification-X1.md'), 'utf8'), 'Verdict: confirmed.\n\nEvidence: the code at file.txt line 1 shows the defect.\n');
});

test('R2-F3: a pair-review run with mode none passes no --phase2-dir to the verification scan', async (t) => {
  const s = await stageRealScanRun(t, 'Evidence: file.txt line 1.', { skill: 'pair-review', seatB: { provider: 'anthropic', runtime: 'claude', model: 'model-B' }, flags: { falsification: true, mode: 'none' } });
  const r = await finishWithRealScan(s);
  assert.equal(r.code, 0, r.out + r.err);
  const scan = (await s.calls()).find((c) => c.argv[0] === 'scan');
  assert.equal(scan.argv.includes('--phase2-dir'), false);
  assert.equal(s.flag(scan, '--forbid-seats'), 'A,B');
});

test('R2-F12: a failed CLI seat attempt that wrote into the target fails the step before any retry', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'error', error: 'boom', touchedFiles: ['source.txt'] }));
  const before = (await s.calls()).length;
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED seat A touched files: .*source\.txt/);
  assert.equal((await s.calls()).slice(before).some((c) => c.script === 'claude-dispatch.mjs'), false, 'no retry is dispatched over a changed target');
});

test('R2-F12: a write recorded in an earlier attempt file still fails the step after a clean retry', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.attempt-1.json'), JSON.stringify({ status: 'error', touchedFiles: ['kept.txt'] }));
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'completed', sessionId: 'sess-A', touchedFiles: [] }));
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED seat A touched files: .*kept\.txt/);
});

test('R2-F12: a failed seat is not retried when the target no longer matches the recorded fingerprint', async (t) => {
  const s = await setup(t, { fingerprint: { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: 'placeholder' } });
  const descFile = path.join(s.run, 'run.json');
  const desc = JSON.parse(await fs.readFile(descFile, 'utf8'));
  desc.fingerprint.snapshotHash = await computeSnapshotHash(s.target);
  await fs.writeFile(descFile, JSON.stringify(desc));
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'error', error: 'boom', touchedFiles: [] }));
  await fs.writeFile(path.join(s.target, 'changed-after-start.txt'), 'x\n');
  const before = (await s.calls()).length;
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED fingerprint: the target no longer matches/);
  assert.equal((await s.calls()).slice(before).some((c) => c.script === 'claude-dispatch.mjs'), false);
});

test('R2-F12: a failed auditor attempt that wrote into the target is not retried', async (t) => {
  const s = await auditorWithBrief(t, { status: 'error', error: 'boom', touchedFiles: ['src/app.js'] }, { output: false });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED auditor touched files: .*src\/app\.js/);
  assert.equal((await dispatches(s)).length, 0);
});

test('R2-F11: a retried auditor that writes nothing does not get the failed attempt\'s leftover output translated', async (t) => {
  const s = await auditorWithBrief(t, { status: 'error', error: 'boom' }, { output: true });
  await s.ctl({ auditorWritesNothing: true });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED auditor output: the CLI auditor completed but did not write/);
  assert.equal((await dispatches(s)).length, 1, 'the auditor was dispatched again');
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false, 'nothing is translated');
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.attempt-1.json'), 'utf8'), '{"preliminary":true}\n', 'the leftover is kept as an attempt file');
  await assert.rejects(fs.access(auditOut(s)));
});

test('R2-F11: a retried auditor that writes its output is translated from the new file and the leftover is archived', async (t) => {
  const s = await auditorWithBrief(t, { status: 'error', error: 'boom' }, { output: true });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"fake":true}\n');
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.attempt-1.json'), 'utf8'), '{"preliminary":true}\n');
  assert.ok(r.lines.some((l) => /^auditor: the failed attempt's output is kept as findings\.audit\.attempt-1\.json/.test(l)), r.out);
});

const deadPid = () => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
const liveChild = (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => child.kill());
  return child;
};

test('R2-F1: a CLI seat whose result.json says running but whose worker is gone is dispatched again by the wait', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'running', workerPid: deadPid(), startedAt: new Date().toISOString() }));
  const before = (await s.calls()).length;
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 0, r.out + r.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls).slice(0, 2), ['claude-dispatch:start', 'claude-dispatch:--wait']);
  assert.ok(r.lines.some((l) => /^seat A: previous attempt ended with status running \(its worker is gone\); dispatched again/.test(l)), r.out);
});

test('R2-F1: a running record with no worker pid is dispatched again only after the start window', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const file = path.join(s.run, 'phase1', 'A', 'result.json');
  await fs.writeFile(file, JSON.stringify({ status: 'running', workerPid: null, startedAt: new Date().toISOString() }));
  let before = (await s.calls()).length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.calls()).slice(before).some((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach')), false, 'a fresh placeholder is still starting');
  await fs.writeFile(file, JSON.stringify({ status: 'running', workerPid: null, startedAt: new Date(Date.now() - 180000).toISOString() }));
  before = (await s.calls()).length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.calls()).slice(before).some((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach')), true, 'a placeholder older than two minutes never started');
});

test('R2-F1: a running record whose pid is alive and matches its recorded start is not dispatched again; a reused pid is [slow]', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const file = path.join(s.run, 'phase1', 'A', 'result.json');
  const child = liveChild(t);
  const running = (workerStartedAt) => fs.writeFile(file, JSON.stringify({ status: 'running', workerPid: child.pid, workerStartedAt, startedAt: workerStartedAt }));
  await running(new Date().toISOString());
  let before = (await s.calls()).length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.calls()).slice(before).some((c) => c.argv.includes('--detach')), false, 'a live worker is left alone');
  await running(new Date(Date.now() - 3600000).toISOString());
  before = (await s.calls()).length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.calls()).slice(before).some((c) => c.argv.includes('--detach')), true, 'a pid reused by another process is not the worker');
});

test('R2-F2: audit --finish dispatches a CLI auditor again when its result.json says running but its worker is gone', async (t) => {
  const s = await auditorWithBrief(t, { status: 'running', workerPid: deadPid(), startedAt: new Date().toISOString() }, { output: false });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((await dispatches(s)).length, 1, 'the auditor is dispatched once more');
  assert.ok(r.lines.some((l) => /^auditor: previous attempt ended with status running \(its worker is gone\); dispatched again/.test(l)), r.out);
});

test('R2-F2: audit --finish keeps waiting for an auditor whose worker is alive', async (t) => {
  const child = liveChild(t);
  const now = new Date().toISOString();
  const s = await auditorWithBrief(t, { status: 'running', workerPid: child.pid, workerStartedAt: now, startedAt: now }, { output: false });
  await s.ctl({ claudeWait: 3 });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal((await dispatches(s)).length, 0);
});

async function opencodeWait(t, { pid, startedAt, logText }) {
  const s = await setup(t, { seatA: { transport: 'native' }, seatB: { provider: 'opencode', runtime: 'opencode', model: 'opencode/fake' } });
  const folder = path.join(s.run, 'phase1', 'B');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'dispatch-pid.json'), JSON.stringify({ pid, startedAt }));
  await fs.writeFile(path.join(folder, 'dispatch-worker.log'), logText);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  return s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '2', '--native-done', 'A');
}

test('R2-F8: an OpenCode dispatcher pid that another process now holds does not keep the seat running [slow]', async (t) => {
  const child = liveChild(t);
  const r = await opencodeWait(t, { pid: child.pid, startedAt: new Date(Date.now() - 3600000).toISOString(), logText: '' });
  assert.ok(r.lines.some((l) => /^seat B: the previous opencode dispatcher \(pid \d+\) ended without a result\.json; dispatched again/.test(l)), r.out);
});

test('R2-F8: a terminal line in dispatch-worker.log ends the wait even while the recorded pid is alive', async (t) => {
  const child = liveChild(t);
  const r = await opencodeWait(t, { pid: child.pid, startedAt: new Date().toISOString(), logText: 'relay: unexpected failure: boom\n' });
  assert.ok(r.lines.some((l) => /^seat B: the previous opencode dispatcher \(pid \d+\) ended without a result\.json; dispatched again/.test(l)), r.out);
});

test('R2-F8: a live matching dispatcher with only progress lines in its log is still running', async (t) => {
  const child = liveChild(t);
  const r = await opencodeWait(t, { pid: child.pid, startedAt: new Date().toISOString(), logText: 'relay: kept the earlier result.json as result.attempt-1.json\n' });
  assert.equal(r.code, 3, r.out + r.err);
});

test('R2-F4: audit --finish removes a CLI verifier worktree from any phase3 dispatch folder, registered or not [slow]', async (t) => {
  const s = await setup(t, { git: true, auditor: { transport: 'native' } });
  const wtFor = async (folderName, file, name) => {
    const wt = path.join(s.base, `wt-${name}`);
    assert.equal(spawnSync('git', ['worktree', 'add', '--detach', wt], { cwd: s.target }).status, 0);
    await fs.writeFile(`${wt}.snapshot-complete`, 'ok');
    const folder = path.join(s.run, 'phase3', folderName);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, file), JSON.stringify({ status: 'completed', worktreePath: wt }));
    return wt;
  };
  const first = await wtFor('verifier-X1', 'result.json', 'v1');
  const second = await wtFor('verifier-X1', 'result.attempt-1.json', 'v1-attempt');
  const third = await wtFor('anything-else', 'result.json', 'v2');
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.writeFile(auditOut(s), '{}');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.includes('worktrees: removed 3'), r.out);
  for (const wt of [first, second, third]) {
    await assert.rejects(fs.access(wt));
    await assert.rejects(fs.access(`${wt}.snapshot-complete`));
  }
});

test('R2-F9: a CLI auditor that completed without its output file fails with both exits named', async (t) => {
  const s = await auditorWithBrief(t, { status: 'completed', finalMessage: '{"audit":true}' }, { output: false });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED auditor output: the CLI auditor completed but did not write .*findings\.audit\.json/);
  assert.match(r.lines.at(-2), /save the finalMessage from .*result\.json as that file/);
  assert.match(r.lines.at(-2), /or remove .*result\.json so the next run dispatches the auditor again/);
  assert.equal((await dispatches(s)).length, 0);
  await fs.rm(path.join(auditDir(s), 'result.json'));
  const again = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal((await dispatches(s)).length, 1, 'removing result.json is the exit that dispatches again');
});

test('R2-F16: a failed Phase 1 seat is dispatched again as a new session in the same worktree, as the Phase 1 doc says', async (t) => {
  const wt = path.join(os.tmpdir(), 'recorded-worktree');
  const s = await setup(t, { seatA: { worktreePath: wt } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'error', error: 'boom', sessionId: 'sess-failed', worktreePath: wt, touchedFiles: [] }));
  const before = (await s.calls()).length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const start = (await s.calls()).slice(before).find((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach'));
  assert.equal(start.argv.includes('--session'), false, 'a Phase 1 retry starts a new session');
  assert.equal(s.flag(start, '--worktree'), wt);
  const doc = await fs.readFile(path.join(SCRIPTS, '..', 'references', 'phase-1-independent-passes.md'), 'utf8');
  assert.match(doc.replace(/\s+/g, ' '), /dispatches that seat again as a new session in the same worktree; it does not resume the failed session/);
});

// ---- Final review round (fix4) ----

const verifierActor = (folder) => ({
  role: 'verifier-1', provider: 'anthropic', runtime: 'claude', model: 'model-V', effort: null, transport: 'cli', sessionId: null,
  outputDir: folder, resultPath: null, worktreePath: null,
});

async function registerVerifier(s, folder) {
  s.desc.verifiers = [verifierActor(folder)];
  await fs.rm(path.join(s.run, 'run.json'));
  await writeRunDescriptor(s.run, s.desc);
}

const noScanOrTranslate = async (s) => {
  const seen = names(await s.calls());
  assert.equal(seen.includes('blind-relabel:translate'), false, 'nothing is translated');
  assert.equal(seen.includes('build-brief:--mode'), false, 'no auditor brief is built');
};

for (const [label, registered, files] of [
  ['an unregistered phase3 dispatch folder', false, { 'result.json': { status: 'completed', touchedFiles: ['node_modules/dep.js'] } }],
  ['a registered verifier output folder', true, { 'result.json': { status: 'completed', touchedFiles: ['node_modules/dep.js'] } }],
  ['a folder that holds only an attempt file', false, { 'result.attempt-2.json': { status: 'error', touchedFiles: ['node_modules/dep.js'] } }],
  ['an earlier attempt file of a verifier whose last result is clean', true, { 'result.attempt-1.json': { status: 'error', touchedFiles: ['node_modules/dep.js'] }, 'result.json': { status: 'completed', touchedFiles: [] } }],
]) {
  test(`final-F1: a verifier that recorded a target write (${label}) fails audit --finish before staging and translate`, async (t) => {
    const s = await prepared(t, { flags: { falsification: true } });
    const folder = registered ? path.join(s.base, 'verifier-out') : path.join(s.run, 'phase3', 'verifier-X1');
    if (registered) await registerVerifier(s, folder);
    await fs.mkdir(folder, { recursive: true });
    for (const [name, record] of Object.entries(files)) await fs.writeFile(path.join(folder, name), JSON.stringify(record));
    await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
    const r = await s.rr('audit', '--run-dir', s.run, '--finish');
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.lines.at(-2), /^FAILED verifier .* touched files: .*node_modules\/dep\.js/);
    await noScanOrTranslate(s);
    await assert.rejects(fs.access(path.join(`${s.run}-audit-input`, 'verification-X1.md')), 'the verification file is not staged');
  });
}

test('final-F1: a verifier write is also caught on a rerun that finds the auditor brief built, and before translate', async (t) => {
  const s = await auditorWithBrief(t, null, { output: false, flags: { falsification: true } });
  const folder = path.join(s.run, 'phase3', 'verifier-X1');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify({ status: 'completed', touchedFiles: ['node_modules/dep.js'] }));
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED verifier .* touched files/);
  assert.equal((await dispatches(s)).length, 0, 'no auditor is dispatched');
  const late = await prepared(t, { auditor: { transport: 'native' }, flags: { falsification: true } });
  assert.equal((await late.rr('audit', '--run-dir', late.run, '--finish')).code, 0, 'the first finish builds the brief and waits for the native auditor');
  const lateFolder = path.join(late.run, 'phase3', 'verifier-X1');
  await fs.mkdir(lateFolder, { recursive: true });
  await fs.writeFile(path.join(lateFolder, 'result.json'), JSON.stringify({ status: 'completed', touchedFiles: ['node_modules/dep.js'] }));
  await fs.writeFile(auditOut(late), '{"native":true}\n');
  const again = await late.rr('audit', '--run-dir', late.run, '--finish');
  assert.equal(again.code, 1, again.out);
  assert.match(again.lines.at(-2), /^FAILED verifier .* touched files/);
  assert.equal((await late.calls()).some((c) => c.argv[0] === 'translate'), false);
});

test('final-F1: clean verifier results pass and the unrecorded inventory is reported', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' }, flags: { falsification: true } });
  const folder = path.join(s.run, 'phase3', 'verifier-X1');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify({ status: 'completed', touchedFiles: [] }));
  await fs.writeFile(path.join(s.run, 'phase3', 'verifier-X1', 'result.attempt-1.json'), JSON.stringify({ status: 'error', touchedFiles: null }));
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 0);
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.some((l) => /^verifiers: checked 1 folder\(s\), no target writes recorded/.test(l)), r.out);
});

test('final-F7: a CLI seat or auditor result that carries a touchedFilesNote reports it even when touchedFiles is an empty list', async (t) => {
  const note = 'node_modules was not inventoried (too many files); a write under it is not detected';
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'completed', sessionId: 'sess-A', touchedFiles: [], touchedFilesNote: note }));
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--native-done', 'A');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.some((l) => l.startsWith('seat A: completed') && l.includes(note)), r.out);
  const a = await auditorWithBrief(t, { status: 'completed', touchedFiles: [], touchedFilesNote: note });
  const done = await a.rr('audit', '--run-dir', a.run, '--finish');
  assert.equal(done.code, 0, done.out + done.err);
  assert.ok(done.lines.some((l) => l.startsWith('auditor: completed') && l.includes(note)), done.out);
  const clean = await auditorWithBrief(t, { status: 'completed', touchedFiles: [] });
  assert.ok((await clean.rr('audit', '--run-dir', clean.run, '--finish')).lines.includes('auditor: completed'), 'a clean inventory prints no note');
});

async function opencodeSeat(t) {
  const previous = process.env.REVIEW_RUN_SCRIPTS_DIR;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_RUN_SCRIPTS_DIR; else process.env.REVIEW_RUN_SCRIPTS_DIR = previous; });
  const s = await setup(t, { seatA: { transport: 'native' }, seatB: { provider: 'opencode', runtime: 'opencode', model: 'opencode/fake' } });
  process.env.REVIEW_RUN_SCRIPTS_DIR = s.hook;
  s.folder = path.join(s.run, 'phase1', 'B');
  s.starts = async () => (await s.calls()).filter((c) => c.script === 'opencode-dispatch.mjs').length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  for (let i = 0; i < 100 && (await s.starts()) === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  return s;
}

test('final-F5: re-dispatching a failed OpenCode seat archives its result.json and worker log first, so the first poll never reads the old failure [slow]', async (t) => {
  const s = await opencodeSeat(t);
  await fs.writeFile(path.join(s.folder, 'result.json'), JSON.stringify({ status: 'error', error: 'old failure' }));
  await s.ctl({ opencodeSleepMs: 1500 });
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-done', 'A');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.includes('old failure'), false, 'the stale failure is not reported');
  assert.ok(r.lines.some((l) => /^seat B: previous attempt ended with status error; dispatched again/.test(l)), r.out);
  assert.equal(JSON.parse(await fs.readFile(path.join(s.folder, 'result.attempt-1.json'), 'utf8')).error, 'old failure');
  assert.match(await fs.readFile(path.join(s.folder, 'dispatch-worker.attempt-1.log'), 'utf8'), /refused to start/, 'the old worker log is kept under the attempt number');
  assert.equal((await fs.readFile(path.join(s.folder, 'dispatch-worker.log'), 'utf8')).includes('refused to start'), false, 'the new worker log starts empty');
});

test('final-F5: a quick rerun while the re-dispatched OpenCode seat still starts does not start a second dispatcher [slow]', async (t) => {
  const s = await opencodeSeat(t);
  await fs.writeFile(path.join(s.folder, 'result.json'), JSON.stringify({ status: 'error', error: 'old failure' }));
  // The fake seat must outlast two review-run starts on a loaded machine; the last wait below still allows 30 s.
  await s.ctl({ opencodeSleepMs: 8000 });
  const before = await s.starts();
  const first = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '0', '--native-done', 'A');
  assert.equal(first.code, 3, first.out + first.err);
  const second = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '0', '--native-done', 'A');
  assert.equal(second.code, 3, second.out + second.err);
  for (let i = 0; i < 100 && (await s.starts()) === before; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await s.starts()) - before, 1, 'one dispatcher serves both waits');
  const done = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-done', 'A');
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal((await s.starts()) - before, 1);
});

test('final-F4: an OpenCode dispatcher that died before writing result.json is dispatched again by the next wait [slow]', async (t) => {
  const s = await opencodeSeat(t);
  await fs.rm(path.join(s.folder, 'result.json'), { force: true });
  await fs.writeFile(path.join(s.folder, 'dispatch-pid.json'), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
  await s.ctl({ opencodeSleepMs: 300 });
  const before = await s.starts();
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-done', 'A');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.lines.some((l) => /^seat B: the previous opencode dispatcher \(pid \d+\) ended without a result\.json; dispatched again/.test(l)), r.out);
  assert.equal((await s.starts()) - before, 1);
});

test('final-F4: a dispatcher whose log ended, though its pid is still held, is also dispatched again; a live one with progress lines is not [slow]', async (t) => {
  const s = await opencodeSeat(t);
  await fs.rm(path.join(s.folder, 'result.json'), { force: true });
  const child = liveChild(t);
  await fs.writeFile(path.join(s.folder, 'dispatch-pid.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
  await fs.writeFile(path.join(s.folder, 'dispatch-worker.log'), 'relay: kept the earlier result.json as result.attempt-1.json\n');
  const before = await s.starts();
  const running = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(running.code, 3, running.out + running.err);
  assert.equal(await s.starts(), before, 'a live dispatcher is not started again');
  await fs.writeFile(path.join(s.folder, 'dispatch-worker.log'), 'relay: unexpected failure: boom\n');
  await s.ctl({ opencodeSleepMs: 300 });
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-done', 'A');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((await s.starts()) - before, 1);
});

test('final-F10: the OpenCode dispatcher record carries a start token (null where the OS reports none), and a record with a matching token outlives a wall-clock start an hour off', async (t) => {
  const s = await opencodeSeat(t);
  const record = JSON.parse(await fs.readFile(path.join(s.folder, 'dispatch-pid.json'), 'utf8'));
  assert.ok(Object.hasOwn(record, 'startToken'), 'startToken is always written');
  if (process.platform === 'win32') assert.equal(record.startToken, null);
  else assert.match(record.startToken, /^(ticks|lstart):/);
  if (process.platform === 'win32') return;
  const child = liveChild(t);
  const { processStartToken } = await import('../detach-utils.mjs');
  await fs.rm(path.join(s.folder, 'result.json'), { force: true });
  await fs.writeFile(path.join(s.folder, 'dispatch-pid.json'), JSON.stringify({ pid: child.pid, startedAt: new Date(Date.now() - 3600000).toISOString(), startToken: processStartToken(child.pid) }));
  await fs.writeFile(path.join(s.folder, 'dispatch-worker.log'), 'relay: kept the earlier result.json as result.attempt-1.json\n');
  const running = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(running.code, 3, running.out + running.err);
});

test('final-F3: a failed Phase 1 seat with no worktree in run.json is retried in the worktree its failed attempt recorded, as a new session', async (t) => {
  const wt = path.join(os.tmpdir(), 'recorded-by-the-attempt');
  const s = await setup(t);
  assert.equal(s.desc.seatA.worktreePath, null, 'the default run.json names no worktree');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const first = (await s.calls()).find((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach'));
  assert.equal(first.argv.includes('--worktree'), false, 'the first dispatch lets the dispatcher choose');
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'error', error: 'boom', sessionId: 'sess-failed', worktreePath: wt, touchedFiles: [] }));
  const before = (await s.calls()).length;
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const start = (await s.calls()).slice(before).find((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach'));
  assert.equal(start.argv.includes('--session'), false, 'a Phase 1 retry starts a new session');
  assert.equal(s.flag(start, '--worktree'), wt, 'the retry reuses the failed attempt\'s worktree');
});

test('seats are started without a time limit: --timeout 0 for Claude and Codex seats, none for OpenCode, and flags.timeoutS when the user set one', async (t) => {
  const starts = async (s) => (await s.calls()).filter((c) => c.argv.includes('--detach'));
  const zero = await setup(t);
  assert.equal((await zero.rr('phase1', '--run-dir', zero.run, '--start')).code, 0);
  for (const call of await starts(zero)) assert.equal(zero.flag(call, '--timeout'), '0', `${call.script} gets --timeout 0`);
  const limited = await setup(t, { flags: { timeoutS: 600 } });
  assert.equal((await limited.rr('phase1', '--run-dir', limited.run, '--start')).code, 0);
  assert.equal((await limited.rr('phase1', '--run-dir', limited.run, '--wait')).code, 0);
  assert.equal((await limited.rr('phase2', '--run-dir', limited.run, '--start')).code, 0);
  const all = await starts(limited);
  assert.ok(all.length >= 4, 'both phases started both seats');
  for (const call of all) assert.equal(limited.flag(call, '--timeout'), '600');
});

test('the auditor is started without a time limit too', async (t) => {
  const s = await prepared(t);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  const dispatch = (await s.calls()).find((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach') && s.flag(c, '--out-dir') === `${s.run}-audit-input`);
  assert.equal(s.flag(dispatch, '--timeout'), '0');
});

test('flags.checklists reach validate, exchange prepare and finish, audit-prep and translate, and no dispatcher', async (t) => {
  const s = await setup(t, { flags: { checklists: ['TARGET', 'CHK'] } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  const calls = await s.calls();
  const has = (script, first) => calls.filter((c) => c.script === script && c.argv[0] === first);
  for (const [script, first] of [['blind-relabel.mjs', 'validate'], ['exchange.mjs', 'prepare'], ['exchange.mjs', 'finish'], ['blind-relabel.mjs', 'audit-prep'], ['blind-relabel.mjs', 'translate']]) {
    const found = has(script, first);
    assert.ok(found.length > 0, `${script} ${first} ran`);
    for (const c of found) assert.deepEqual(c.argv.filter((a, i) => c.argv[i - 1] === '--checklist'), ['TARGET', 'CHK'], `${script} ${first}`);
  }
  for (const c of calls.filter((x) => x.script.endsWith('-dispatch.mjs'))) assert.equal(c.argv.includes('--checklist'), false, `${c.script} takes no checklist`);
});

async function fingerprinted(t, options = {}) {
  const s = await setup(t, options);
  const file = path.join(s.run, 'run.json');
  const desc = JSON.parse(await fs.readFile(file, 'utf8'));
  desc.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(s.target) };
  await fs.writeFile(file, JSON.stringify(desc));
  s.drift = () => fs.writeFile(path.join(s.target, `drift-${Date.now()}.txt`), 'x\n');
  return s;
}

test('F1: phase1 --start run twice starts each CLI seat once; the second run reports it and --wait still works', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const starts = async () => (await s.calls()).filter((c) => c.argv.includes('--detach')).length;
  const first = await starts();
  const again = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /seat A: already started \(result\.json says completed\)/);
  assert.match(again.out, /seat B: already started/);
  assert.equal(await starts(), first, 'no second dispatch');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
});

test('F1: a phase2 --start rerun does not resume a seat that already has an exchange dispatch', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const starts = async () => (await s.calls()).filter((c) => c.argv.includes('--detach')).length;
  const first = await starts();
  const again = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /exchange already started/);
  assert.equal(await starts(), first);
});

test('F2: an OpenCode seat is started with --timeout 0, not the dispatcher default of 1800 s', async (t) => {
  const s = await opencodeSeat(t);
  const call = (await s.calls()).find((c) => c.script === 'opencode-dispatch.mjs');
  assert.equal(s.flag(call, '--timeout'), '0');
});

test('F3-F6: the saved source fingerprint is checked at phase1 start, phase1 wait, phase2 start and phase2 wait', async (t) => {
  const refused = (r) => {
    assert.equal(r.code, 1, r.out);
    assert.match(r.lines.at(-2), /^FAILED fingerprint: the target no longer matches/);
  };
  const a = await fingerprinted(t);
  await a.drift();
  refused(await a.rr('phase1', '--run-dir', a.run, '--start'));
  assert.equal((await a.calls()).some((c) => c.argv.includes('--detach')), false, 'nothing is dispatched on a drifted target');
  const b = await fingerprinted(t);
  assert.equal((await b.rr('phase1', '--run-dir', b.run, '--start')).code, 0);
  await b.drift();
  refused(await b.rr('phase1', '--run-dir', b.run, '--wait'));
  assert.equal((await b.calls()).some((c) => c.script === 'blind-relabel.mjs'), false, 'no validate on a drifted target');
  const c = await fingerprinted(t);
  assert.equal((await c.rr('phase1', '--run-dir', c.run, '--start')).code, 0);
  assert.equal((await c.rr('phase1', '--run-dir', c.run, '--wait')).code, 0);
  await c.drift();
  refused(await c.rr('phase2', '--run-dir', c.run, '--start'));
  assert.equal((await c.calls()).some((x) => x.script === 'exchange.mjs'), false, 'no exchange prepare on a drifted target');
  const d = await fingerprinted(t);
  assert.equal((await d.rr('phase1', '--run-dir', d.run, '--start')).code, 0);
  assert.equal((await d.rr('phase1', '--run-dir', d.run, '--wait')).code, 0);
  assert.equal((await d.rr('phase2', '--run-dir', d.run, '--start')).code, 0);
  await d.drift();
  refused(await d.rr('phase2', '--run-dir', d.run, '--wait'));
  assert.equal((await d.calls()).some((x) => x.script === 'exchange.mjs' && x.argv[0] === 'finish'), false, 'no exchange finish on a drifted target');
});

test('F8: a native auditor whose file exists is not done until --native-done auditor names it', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  const first = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(first.code, 0, first.out);
  assert.match(first.lines.at(-1), /--native-done auditor/);
  await fs.mkdir(`${s.run}-audit-input`, { recursive: true });
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"partial":true}\n');
  const partial = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(partial.code, 3, partial.out);
  assert.match(partial.lines.at(-1), /a file alone cannot show the agent finished.*--native-done auditor/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs' && c.argv[0] === 'translate'), false, 'no translate');
  const done = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(done.code, 0, done.out);
  assert.throws(() => parseArgs(['audit', '--run-dir', 'r', '--finish', '--native-done', 'C']), /--native-done takes seat letters/);
});

test('F7: falsification requested with fewer verification files than qualifying claims stops audit --finish; --accept-missing-verifiers goes on and says INCOMPLETE', async (t) => {
  const s = await setup(t, { flags: { falsification: true } });
  await s.ctl({ qualified: 2 });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const refused = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.lines.at(-2), /^FAILED verifiers: falsification was requested and 2 disputed HIGH\/CRITICAL claim\(s\) qualify, but 1 verification file\(s\) exist/);
  assert.equal((await s.calls()).some((c) => c.script === 'build-brief.mjs' && s.flag(c, '--mode') === 'auditor'), false, 'no auditor brief');
  const accepted = await s.rr('audit', '--run-dir', s.run, '--finish', '--accept-missing-verifiers');
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /falsification INCOMPLETE: falsification was requested and 2 disputed/);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--start', '--accept-missing-verifiers']), /only accepted by audit/);
});

test('F12: an exchange warning that every rebuttal conceded reaches the report, and next asks for the audit-depth decision', async (t) => {
  const s = await setup(t);
  await s.ctl({ concede: 8, dispute: 0, finishWarning: 'exchange: WARNING: all 8 rebuttals conceded and none disputed; a light audit would re-check none of these findings, so use --audit-depth full' });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 0, r.out);
  assert.ok(r.lines.some((l) => l.startsWith('exchange: WARNING: all 8 rebuttals conceded')), r.out);
  assert.match(r.lines.at(-1), /^next: decide the audit depth first: after a zero-dispute exchange a full audit is the safer choice; run: review-run audit .* --prepare --audit-depth full .or --audit-depth light to keep the light audit.$/);
  const quiet = await setup(t, { flags: { auditDepth: 'full' } });
  await quiet.ctl({ concede: 8, dispute: 0, finishWarning: 'exchange: WARNING: all 8 rebuttals conceded and none disputed; use --audit-depth full (nothing to do if it is already full)' });
  assert.equal((await quiet.rr('phase1', '--run-dir', quiet.run, '--start')).code, 0);
  assert.equal((await quiet.rr('phase1', '--run-dir', quiet.run, '--wait')).code, 0);
  assert.equal((await quiet.rr('phase2', '--run-dir', quiet.run, '--start')).code, 0);
  const full = await quiet.rr('phase2', '--run-dir', quiet.run, '--wait');
  assert.match(full.lines.at(-1), /^next: run: review-run audit/, 'already full: no decision needed');
});

test('phase2 --wait: when only a few claims exist and all were conceded, next is the full-audit command, not a decision', async (t) => {
  const s = await setup(t);
  await s.ctl({ concede: 1, dispute: 0, finishWarning: 'exchange: WARNING: all 1 rebuttals conceded and none disputed; use --audit-depth full' });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 0, r.out);
  assert.match(r.lines.at(-1), /^next: run: review-run audit .* --prepare --audit-depth full \(all 1 claim\(s\) were conceded.*--audit-depth light to keep the light audit\)$/);
  assert.doesNotMatch(r.lines.at(-1), /decide the audit depth first/);
  const many = await setup(t);
  await many.ctl({ concede: 8, dispute: 0, finishWarning: 'exchange: WARNING: all 8 rebuttals conceded and none disputed; use --audit-depth full' });
  assert.equal((await many.rr('phase1', '--run-dir', many.run, '--start')).code, 0);
  assert.equal((await many.rr('phase1', '--run-dir', many.run, '--wait')).code, 0);
  assert.equal((await many.rr('phase2', '--run-dir', many.run, '--start')).code, 0);
  assert.match((await many.rr('phase2', '--run-dir', many.run, '--wait')).lines.at(-1), /decide the audit depth first/, 'a larger run still asks');
});

test('audit with no claims from either seat: no auditor brief, an empty findings.json, and next points at the manifest and report', async (t) => {
  const s = await setup(t);
  await s.ctl({ zeroClaims: true });
  const prep = await s.rr('audit', '--run-dir', s.run, '--prepare');
  assert.equal(prep.code, 0, prep.out + prep.err);
  assert.ok(prep.lines.some((l) => /no claims from either seat: the auditor and the scorecard are not needed/.test(l)), prep.out);
  assert.match(prep.lines.at(-1), /^next: run: build-manifest\.mjs --run-dir .*, then build-report\.mjs --run-dir /);
  const file = path.join(s.run, 'phase3', 'findings.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { audit_depth: 'light', zero_claims: true, findings: [] });
  const finish = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(finish.code, 0, finish.out);
  assert.match(finish.lines.at(-1), /^next: run: build-manifest\.mjs/);
  assert.equal((await s.calls()).some((c) => c.script === 'build-brief.mjs'), false, 'no auditor brief is built');
  assert.ok((await s.calls()).some((c) => c.script === 'blind-relabel.mjs' && c.argv[0] === 'clear-cache'), 'the cache is cleared as on the normal path');
  const claims = await setup(t);
  assert.equal((await claims.rr('audit', '--run-dir', claims.run, '--prepare')).code, 0);
  assert.equal(await fs.access(path.join(claims.run, 'phase3', 'findings.json')).then(() => true, () => false), false, 'a run with claims writes no empty findings file');
});

test('F13: a seat or auditor that hit a usage limit is not dispatched again before its retryAfter time', async (t) => {
  const later = new Date(Date.now() + 2 * 3600 * 1000);
  const clock = `${((later.getHours() + 11) % 12) + 1}:${String(later.getMinutes()).padStart(2, '0')} ${later.getHours() >= 12 ? 'PM' : 'AM'}`;
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'rate-limited', retryAfter: clock, touchedFiles: [] }));
  const before = (await s.calls()).length;
  const waiting = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3, waiting.out);
  assert.match(waiting.lines.at(-1), new RegExp(`seat A hit a usage limit until ${clock}`));
  assert.equal((await s.calls()).slice(before).some((c) => c.argv.includes('--detach')), false, 'no new session while limited');
  const past = new Date(Date.now() - 60000);
  const pastClock = `${((past.getHours() + 11) % 12) + 1}:${String(past.getMinutes()).padStart(2, '0')} ${past.getHours() >= 12 ? 'PM' : 'AM'}`;
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'rate-limited', retryAfter: pastClock, touchedFiles: [] }));
  const retry = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(retry.code, 0, retry.out);
  assert.ok(retry.lines.some((l) => /previous attempt ended with status rate-limited; dispatched again/.test(l)), 'after the time, the usual retry runs');
  const a = await auditorWithBrief(t, { status: 'rate-limited', retryAfter: clock, touchedFiles: [] }, { output: false });
  const limited = await a.rr('audit', '--run-dir', a.run, '--finish');
  assert.equal(limited.code, 3, limited.out);
  assert.match(limited.lines.at(-1), /the auditor hit a usage limit until/);
  assert.equal((await dispatches(a)).length, 0);
});

test('a native Codex pair on a Codex host: file-channel briefs for both seats, native waits, an unverified-identity gate line, and a native auditor', async (t) => {
  const native = (model) => ({ provider: 'openai', runtime: 'codex', model, transport: 'native' });
  const s = await setup(t, { skill: 'pair-review', host: 'codex', seatA: native('gpt-5.6-sol'), seatB: native('gpt-5.6-terra'), auditor: native('gpt-5.6-sol'), flags: { mode: 'collaborate' } });
  const start = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(start.code, 0, start.out);
  assert.match(start.out, /seat A: native codex; spawn it with brief .*brief-A.txt; it writes .*A-findings.md/);
  assert.match(start.out, /seat B: native codex; spawn it with brief .*brief-B.txt; it writes .*B-findings.md/);
  const briefs = (await s.calls()).filter((c) => c.script === 'build-brief.mjs' && s.flag(c, '--mode') === 'phase1');
  assert.deepEqual(briefs.map((c) => s.flag(c, '--channel')), ['file', 'file'], 'a native Codex seat writes its own file');
  assert.deepEqual(briefs.map((c) => path.basename(s.flag(c, '--output-path'))), ['A-findings.md', 'B-findings.md']);
  assert.equal((await s.calls()).some((c) => c.argv.includes('--detach')), false, 'no CLI dispatcher runs');
  for (const role of ['A', 'B']) await fs.writeFile(path.join(s.run, 'phase1', role + '-findings.md'), `## ${role}1\nclaim\n`);
  const waiting = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3, waiting.out);
  const wait = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A,B');
  assert.equal(wait.code, 0, wait.out);
  assert.ok(wait.lines.includes('models distinct: requested ids differ; effective distinctness unverified (recorded family-distinct)'), wait.out);
  const exchange = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.equal(exchange.code, 0, exchange.out);
  assert.match(exchange.out, /seat A: native; resume it with brief/);
  assert.match(exchange.out, /seat B: native; resume it with brief/);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  const audit = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(audit.code, 0, audit.out);
  assert.match(audit.out, /auditor: native; spawn it with brief/);
  const auditBrief = (await s.calls()).find((c) => c.script === 'build-brief.mjs' && s.flag(c, '--mode') === 'auditor');
  assert.equal(s.flag(auditBrief, '--channel'), 'file');
});

const turn = (type, extra = {}) => JSON.stringify({ type, ...(type === 'assistant' ? { message: { id: String(Math.random()), stop_reason: extra.stop ?? null, content: [{ type: 'text', text: 'x' }] } } : { message: { role: 'user', content: 'go' } }) });

test('--native-agent: a native seat is done when its transcript shows a final reply, no --native-done needed; the id is remembered for later runs', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  const transcript = path.join(s.base, 'agent-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'tool_use' })].join('\n') + '\n');
  const working = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', `A=${transcript}`);
  assert.equal(working.code, 3, working.out);
  assert.match(working.lines.at(-1), /seat A's agent is still working \(its transcript has no final reply yet\)/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs'), false, 'no validate while the agent works');
  const saved = JSON.parse(await fs.readFile(path.join(s.run, 'native-agents.json'), 'utf8'));
  assert.equal(saved.A, transcript);
  await fs.appendFile(transcript, [turn('assistant', { stop: 'end_turn' })].join('\n') + '\n');
  const done = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(done.code, 0, done.out);
  assert.ok(done.lines.includes('seat A: output found (native, transcript shows the agent finished)'), done.out);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--wait', '--native-agent', 'C=x']), /--native-agent takes ROLE=/);
});

test('--native-agent: the transcript decides when the agent works again after a new prompt (Phase 2), and an unmatched agent id is a failure, not a wait', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  const transcript = path.join(s.base, 'agent-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'end_turn' })].join('\n') + '\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', `A=${transcript}`)).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase2', 'A-rebuttals-raw.md'), '## Rebuttals (from A) of B claims\n\n### P1\nCONCEDE\n');
  await fs.appendFile(transcript, turn('user') + '\n');
  const again = await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(again.code, 3, again.out);
  await fs.appendFile(transcript, turn('assistant', { stop: 'end_turn' }) + '\n');
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1')).code, 0);
  const missing = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await missing.rr('phase1', '--run-dir', missing.run, '--start')).code, 0);
  await fs.writeFile(path.join(missing.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'no-agents '));
  t.after(() => fs.rm(config, { recursive: true, force: true }));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  const none = await missing.rr('phase1', '--run-dir', missing.run, '--wait', '--max-wait', '1', '--native-agent', 'A=a0123456789abcdef');
  assert.equal(none.code, 1, none.out);
  assert.match(none.lines.at(-2), /^FAILED native agent A: a0123456789abcdef matched 0 transcripts/);
});

test('--native-agent auditor=: the native auditor is done from its transcript', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  await fs.mkdir(`${s.run}-audit-input`, { recursive: true });
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"fake":true}\n');
  const transcript = path.join(s.base, 'auditor-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'tool_use' })].join('\n') + '\n');
  const working = await s.rr('audit', '--run-dir', s.run, '--finish', '--max-wait', '1', '--native-agent', `auditor=${transcript}`);
  assert.equal(working.code, 3, working.out);
  assert.match(working.lines.at(-1), /the auditor's agent is still working/);
  await fs.appendFile(transcript, turn('assistant', { stop: 'end_turn' }) + '\n');
  const done = await s.rr('audit', '--run-dir', s.run, '--finish', '--max-wait', '1');
  assert.equal(done.code, 0, done.out);
  assert.ok(done.lines.includes('auditor: transcript shows the agent finished'), done.out);
});

test('mixed layout (a host with no support rules): Claude CLI seat A and auditor started detached, native Codex seat B waited for by its file', async (t) => {
  const s = await setup(t, { host: 'descriptor-host-name', seatB: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-luna', transport: 'native' } });
  const start = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(start.code, 0, start.out);
  assert.match(start.out, /seat A: started \(cli claude, file channel\); status record .*result\.json/);
  assert.match(start.out, /seat B: native codex; spawn it with brief .*brief-B\.txt; it writes .*B-findings\.md/);
  const briefs = (await s.calls()).filter((c) => c.script === 'build-brief.mjs' && s.flag(c, '--mode') === 'phase1');
  assert.deepEqual(briefs.map((c) => s.flag(c, '--channel')), ['file', 'file']);
  const claudeStarts = (await s.calls()).filter((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach'));
  assert.equal(claudeStarts.length, 1, 'only the Claude seat is a CLI dispatch');
  assert.equal((await s.calls()).some((c) => c.script === 'codex-dispatch.mjs'), false, 'no nested Codex CLI start');
  await fs.writeFile(path.join(s.run, 'phase1', 'B-findings.md'), '## B1\nclaim\n');
  const waiting = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3, waiting.out);
  const wait = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'B');
  assert.equal(wait.code, 0, wait.out);
  assert.ok(wait.lines.includes('seat A: completed (cli claude)'), wait.out);
  const exchange = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.equal(exchange.code, 0, exchange.out);
  assert.match(exchange.out, /seat A: resumed \(cli claude\)/);
  assert.match(exchange.out, /seat B: native; resume it with brief/);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  const audit = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(audit.code, 0, audit.out);
  assert.ok(audit.lines.includes('auditor: dispatched (cli claude)'), audit.out);
});

test('--audit-depth: set on audit --prepare it is written into run.json and the auditor brief and translate use it; it cannot change once the auditor brief exists', async (t) => {
  const s = await setup(t);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--start', '--audit-depth', 'full']), /only accepted by audit/);
  assert.throws(() => parseArgs(['audit', '--run-dir', 'r', '--prepare', '--audit-depth', 'deep']), /must be light or full/);
  const prepare = await s.rr('audit', '--run-dir', s.run, '--prepare', '--audit-depth', 'full');
  assert.equal(prepare.code, 0, prepare.out);
  assert.ok(prepare.lines.includes('audit depth: full (written to run.json)'), prepare.out);
  assert.equal(JSON.parse(await fs.readFile(path.join(s.run, 'run.json'), 'utf8')).flags.auditDepth, 'full');
  const finish = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(finish.code, 0, finish.out);
  const brief = (await s.calls()).find((c) => c.script === 'build-brief.mjs' && s.flag(c, '--mode') === 'auditor');
  assert.equal(s.flag(brief, '--audit-depth'), 'full');
  const translate = (await s.calls()).find((c) => c.script === 'blind-relabel.mjs' && c.argv[0] === 'translate');
  assert.equal(s.flag(translate, '--audit-depth'), 'full');
  const late = await s.rr('audit', '--run-dir', s.run, '--finish', '--audit-depth', 'light');
  assert.equal(late.code, 1, late.out);
  assert.match(late.lines.at(-2), /^FAILED audit depth: the auditor brief was already built at depth full/);
});

test('a native auditor with --native-agent: no file yet and the agent still working is a wait, the agent done with no file is a failure, no agent id prints the spawn line with both ways to continue', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  const spawnLine = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(spawnLine.code, 0, spawnLine.out);
  assert.match(spawnLine.lines.at(-1), /^next: spawn the auditor, then rerun: .*--native-agent auditor=<its agent id> .or --native-done auditor/);
  const transcript = path.join(s.base, 'auditor-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'tool_use' })].join('\n') + '\n');
  const working = await s.rr('audit', '--run-dir', s.run, '--finish', '--max-wait', '1', '--native-agent', `auditor=${transcript}`);
  assert.equal(working.code, 3, working.out);
  assert.match(working.lines.at(-1), /the auditor's agent is still working/);
  await fs.appendFile(transcript, turn('assistant', { stop: 'end_turn' }) + '\n');
  process.env.REVIEW_FILE_GRACE_S = '1';
  t.after(() => { delete process.env.REVIEW_FILE_GRACE_S; });
  const noFile = await s.rr('audit', '--run-dir', s.run, '--finish', '--max-wait', '1');
  assert.equal(noFile.code, 1, noFile.out);
  assert.match(noFile.lines.at(-2), /^FAILED auditor output: the auditor's agent finished but .*findings\.audit\.json does not exist \(waited 1 s/);
  process.env.REVIEW_FILE_GRACE_S = '20';
  const audited = path.join(path.dirname(s.run), path.basename(s.run) + '-audit-input', 'findings.audit.json');
  const pending = s.rr('audit', '--run-dir', s.run, '--finish', '--max-wait', '1');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fs.mkdir(path.dirname(audited), { recursive: true });
  await fs.writeFile(audited, '{"findings":[]}');
  const lateWrite = await pending;
  assert.ok(!lateWrite.out.includes('does not exist'), 'a write that lands after the transcript shows done is waited for: ' + lateWrite.out);
});

test('a native seat and a native auditor get a ready message file with the brief, the output path and the blinding rule', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' }, auditor: { transport: 'native' } });
  const start = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(start.code, 0, start.out);
  const p1 = path.join(s.run, 'phase1', 'prompt-A.txt');
  assert.ok(start.out.includes('prompt to give it: ' + p1), start.out);
  const text = await fs.readFile(p1, 'utf8');
  assert.ok(text.includes(path.join(s.run, 'phase1', 'brief-A.txt')), 'names the brief');
  assert.ok(text.includes(path.join(s.run, 'phase1', 'A-findings.md')), 'names the output file');
  assert.match(text, /Do not read any other file in the run folder except the brief and the task packet it names/);
  assert.match(text, /reply with only the word written/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--native-done', 'A')).code, 0);
  const exchange = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(exchange.out.includes('prompt to send it: ' + path.join(s.run, 'phase2', 'prompt-A.txt')), exchange.out);
  assert.match(await fs.readFile(path.join(s.run, 'phase2', 'prompt-A.txt'), 'utf8'), /Phase 2\. Read your delta brief from .*delta-brief-A\.txt/);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  const audit = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.ok(audit.out.includes('prompt to give it: ' + path.join(s.run, 'phase3', 'prompt-auditor.txt')), audit.out);
  assert.match(await fs.readFile(path.join(s.run, 'phase3', 'prompt-auditor.txt'), 'utf8'), /You are a fresh independent auditor\. Read your complete instructions from .*auditor-brief\.txt/);
});

test('--local puts the current time, local and UTC, on the first line of the report', async (t) => {
  const s = await setup(t);
  const plain = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.doesNotMatch(plain.lines[0], /^time: /);
  const s2 = await setup(t);
  const stamped = await s2.rr('phase1', '--run-dir', s2.run, '--start', '--local');
  assert.match(stamped.lines[0], /^time: \d{1,2}:\d{2} (AM|PM) \(\d{2}:\d{2} UTC\)$/);
  assert.equal(clockLine(new Date(Date.UTC(2026, 9, 7, 17, 7))).endsWith('(17:07 UTC)'), true);
});

test('phase1 --start warns when the packet turns web verification off but run.json flags.repoOnly is not true', async (t) => {
  const s = await setup(t, {});
  const packet = path.join(s.run, 'task-packet.md');
  await fs.appendFile(packet, '\nWeb verification is off (repo-only review).\n');
  const warned = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(warned.code, 0, warned.out);
  assert.match(warned.out, /warning: the task packet says web verification is off but run\.json flags\.repoOnly is not true/);
});

const reply = (text) => JSON.stringify({ type: 'assistant', message: { id: String(Math.random()), stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const rollout = (message) => [
  { type: 'session_meta', payload: { id: 'x' } },
  { type: 'event_msg', payload: { type: 'task_started' } },
  { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

test('--native-agent: a seat whose agent ended without its file fails with the agent\'s last reply instead of waiting for ever (Claude transcript and Codex rollout)', async (t) => {
  process.env.REVIEW_FILE_GRACE_S = '0';
  t.after(() => { delete process.env.REVIEW_FILE_GRACE_S; });
  const s = await setup(t, { host: 'descriptor-host-name', seatA: { transport: 'native' }, seatB: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-luna', transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const claude = path.join(s.base, 'claude-agent.jsonl');
  await fs.writeFile(claude, [turn('user'), reply('blocked: shell tool timed out')].join('\n') + '\n');
  const failed = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-agent', 'A=' + claude);
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.lines.at(-2), /^FAILED seat A: its agent finished without a usable .*A-findings\.md; last reply: "blocked: shell tool timed out"\. If that reports a tool, shell or permission failure it is a host failure/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  const codex = path.join(s.base, 'codex-rollout.jsonl');
  await fs.writeFile(codex, rollout('Blocked: all file/process tools time out.'));
  const second = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-agent', 'B=' + codex);
  assert.equal(second.code, 1, second.out);
  assert.match(second.lines.at(-2), /^FAILED seat B: its agent finished without a usable .*B-findings\.md; last reply: "Blocked: all file\/process tools time out\."/);
});

test('--native-agent: the final write landing after the transcript shows the agent done is waited for, and a finished agent with its file passes', async (t) => {
  process.env.REVIEW_FILE_GRACE_S = '20';
  t.after(() => { delete process.env.REVIEW_FILE_GRACE_S; });
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const transcript = path.join(s.base, 'late-agent.jsonl');
  await fs.writeFile(transcript, [turn('user'), reply('written, 1 finding')].join('\n') + '\n');
  const pending = s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-agent', 'A=' + transcript);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  const late = await pending;
  assert.equal(late.code, 0, late.out);
  assert.ok(late.lines.includes('seat A: output found (native, transcript shows the agent finished)'), late.out);
});

test('phase2 --wait: per-seat concede-all warnings are dropped when the all-conceded warning is present', async (t) => {
  const s = await setup(t);
  await s.ctl({ finishWarning: 'exchange: WARNING: seat A conceded all 3 peer claims; the exchange added little for that side: consider --audit-depth full\nexchange: WARNING: seat B conceded all 3 peer claims; the exchange added little for that side: consider --audit-depth full\nexchange: WARNING: all 6 rebuttals conceded and none disputed; use --audit-depth full' });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(r.lines.filter((l) => l.includes('WARNING')).length, 1, r.out);
  assert.ok(r.lines.some((l) => l.includes('none disputed')), r.out);
});

test('phase2 --start: next does not ask to resume a native seat that was skipped', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  await s.ctl({ skipped: { A: 'seat B has no findings' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
  const start = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(start.lines.some((l) => l.startsWith('seat A: skipped')), start.out);
  assert.doesNotMatch(start.lines.at(-1), /resume each native seat/);
  assert.match(start.lines.at(-1), /^next: run: review-run phase2 /);
});

test('seatRanNothing: a No-findings file that says the review was incomplete, or a stderr with a failed exec, is not a clean verdict', () => {
  const none = '# Seat B findings\n\n## No findings\n\nReview incomplete. No target source or evidence files could be read.\n';
  assert.match(seatRanNothing(none, ''), /its file says "Review incomplete"/);
  assert.match(seatRanNothing('## No findings\n\nChecks performed: read a.py\n', 'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "x" }'), /its stderr shows "exec_command failed"/);
  assert.equal(seatRanNothing('## No findings\n\nChecks performed: ran pytest, 12 passed\n', 'noisy but fine'), null);
  assert.equal(seatRanNothing('## B1 - real claim\nSeverity: LOW\n\nmention of review incomplete in prose\n', 'exec_command failed'), null, 'a seat with claims is not judged here');
});

test('phase1 --wait: a CLI seat B that wrote "No findings" after its commands failed fails the step instead of validating clean', async (t) => {
  const s = await setup(t);
  const nl = String.fromCharCode(10);
  await s.ctl({ finalB: ['# Seat B findings', '', '## No findings', '', 'Review incomplete. Command execution failed before startup.', ''].join(nl) });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /seat B: wrote "No findings" but did not review: its file says "Review incomplete"/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs'), false, 'validate must not run');
});

test('formatElapsed: seconds under a minute, minutes and seconds above, unknown for a bad value', () => {
  assert.equal(formatElapsed(42000), '42s');
  assert.equal(formatElapsed(8 * 60000 + 5000), '8m05s');
  assert.equal(formatElapsed(Number.NaN), 'unknown time');
  assert.equal(formatElapsed(-1), 'unknown time');
});

test('seatStatusLines: a running CLI seat shows its elapsed time and live exec failures, a finished one its duration, a native one how to get progress', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const desc = { ...JSON.parse(await fs.readFile(path.join(s.run, 'run.json'), 'utf8')), runDir: s.run };
  const dir = path.join(s.run, 'phase1', 'B');
  await fs.mkdir(dir, { recursive: true });
  const started = new Date(Date.UTC(2026, 9, 8, 19, 33, 0)).toISOString();
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ status: 'running', startedAt: started }));
  await fs.writeFile(path.join(dir, 'result.stderr.live.log'), ['ERROR exec_command failed: x', 'noise', 'ERROR exec_command failed: y', ''].join(String.fromCharCode(10)));
  const now = Date.UTC(2026, 9, 8, 19, 41, 30);
  const running = await seatStatusLines(desc, 'phase1', {}, now);
  assert.equal(running[0], 'seat A: native; pass --native-agent A=<agent id> to see its progress');
  assert.equal(running[1], 'seat B: codex running 8m30s, 2 exec_command failure(s) so far');
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ status: 'completed', startedAt: started, durationMs: 77000 }));
  assert.equal((await seatStatusLines(desc, 'phase1', {}, now))[1], 'seat B: codex completed in 1m17s');
  await fs.rm(path.join(dir, 'result.json'));
  assert.equal((await seatStatusLines(desc, 'phase1', {}, now))[1], 'seat B: codex cli, no status record yet');
});

test('execFailureCount: counts exec_command failures in a seat stderr', () => {
  assert.equal(execFailureCount('ok\nERROR exec_command failed: x\nERROR Exec_Command failed: y\n'), 2);
  assert.equal(execFailureCount(''), 0);
  assert.equal(execFailureCount(null), 0);
});


test('seatRanNothing: only the seat\'s own opening statement counts, not the same words inside a sentence about the target', () => {
  const nl = String.fromCharCode(10);
  const file = (...body) => ['# Seat B findings', '', '## No findings', '', ...body, ''].join(nl);
  assert.match(seatRanNothing(file('Review incomplete. No target source files could be read.'), ''), /its file says "Review incomplete"/);
  assert.match(seatRanNothing(file('**Command execution failed before startup.**'), ''), /its file says "Command execution failed"/);
  assert.equal(seatRanNothing(file('The branch that logs "could not read config" is guarded; all 4 files were read.'), ''), null);
  assert.equal(seatRanNothing(file('The absent docs do not leave the review incomplete.'), ''), null);
  const stderr = ['failed to create unified exec process', 'CreateProcess { error }', 'exec_command failed: x'].join(nl);
  assert.match(seatRanNothing(file('Checked everything.'), stderr), /its stderr shows "failed to create unified exec process"/);
  assert.equal(execFailureCount(stderr), 3, 'the same pattern counts every kind of failed command');
});

test('phase2 --wait: next names the real reason when a seat conceded all its claims but there were disputes', async (t) => {
  const s = await setup(t);
  await s.ctl({ concede: 4, dispute: 2, finishWarning: 'exchange: WARNING: seat A conceded all 4 peer claims; the exchange added little for that side: consider --audit-depth full' });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.match(r.lines.at(-1), /decide the audit depth first: when one seat conceded all its claims a full audit is the safer choice/);
  assert.doesNotMatch(r.lines.at(-1), /zero-dispute/);
});

test('phase1 --wait: a NATIVE seat that wrote "No findings" and said its review was incomplete fails the step like a CLI seat', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const nl = String.fromCharCode(10);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), ['# Seat A findings', '', '## No findings', '', 'Review incomplete. I could not read the target.', ''].join(nl));
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /seat A: wrote "No findings" but did not review: its file says "Review incomplete"/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs' && c.argv[0] === 'validate'), false, 'validate must not run');
});

test('audit --finish: verification files that run.json will not use are reported, not silently ignored', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.mkdir(path.join(s.run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const finish = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.ok(finish.lines.some((l) => /warning: 1 verification file\(s\) in phase3 are ignored because run\.json flags\.falsification is false/.test(l)), finish.out);
  const on = await setup(t, { flags: { falsification: true } });
  assert.equal((await on.rr('audit', '--run-dir', on.run, '--prepare')).code, 0);
  assert.equal((await on.rr('audit', '--run-dir', on.run, '--finish')).lines.some((l) => /are ignored because/.test(l)), false);
});

test('seatRanNothing: the statement counts anywhere in the No findings section, not inside a fence, and never for a file that has claims', () => {
  const nl = String.fromCharCode(10);
  const fence = String.fromCharCode(96).repeat(3);
  const text = (...l) => l.join(nl) + nl;
  assert.match(seatRanNothing(text('## No findings', '', 'Checked read a.py.', '', 'Review incomplete. Could not run the tests.'), ''), /its file says "Review incomplete"/, 'a second paragraph counts');
  assert.equal(seatRanNothing(text('## No findings', '', 'All files read.', '', '## Checks performed', '- Could not run pytest, ran node instead.'), ''), null, 'the next section is not part of the statement');
  assert.equal(seatRanNothing(text('## B1 real claim', 'Severity: LOW', '', '## No findings', 'Review incomplete.'), ''), null, 'a file with claims goes to validate');
  assert.equal(seatRanNothing(text('## A1 claim', 'Severity: LOW', '', fence, '## No findings', 'Review incomplete.', fence), ''), null, 'a quoted marker inside a fence is not the marker');
  assert.equal(seatRanNothing(text(fence, '## No findings', fence, 'Review incomplete.'), ''), null, 'no marker outside a fence');
});

test('otherPendingSeats: the next line also names the seats the wait did not reach', () => {
  const status = ['seat A: claude running 2m', 'seat B: openai running 1m'];
  assert.equal(otherPendingSeats('seat A (claude) is still running; rerun this command', status), ' (seat B is not finished either)');
  assert.equal(otherPendingSeats('seat A is still running', ['seat A: claude running 2m', 'seat B: openai completed in 3m']), '');
});

test('warnExtraRepos: a changed extra repository is named on stderr once; an unchanged one is silent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extra-repo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.md'), 'one\n');
  const { computeSnapshotHash } = await import('../preflight.mjs');
  const desc = { extraRepos: [{ dir, snapshotHash: await computeSnapshotHash(dir) }] };
  const seen = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { seen.push(String(chunk)); return true; };
  try {
    await warnExtraRepos(desc);
    assert.deepEqual(seen, []);
    await fs.writeFile(path.join(dir, 'a.md'), 'two\n');
    await warnExtraRepos(desc);
    await warnExtraRepos(desc);
  } finally {
    process.stderr.write = real;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], new RegExp(`WARNING: .*changed since preflight`));
});

test('failureDetail: the reason lines before the last one are kept, exchange progress lines are not', () => {
  const text = ['exchange: validate both seats', 'append-rebuttals: line 12: claim id P1 survives inside an Evidence fence', 'append-rebuttals: line 31: claim id P2 survives inside an Evidence fence', 'exchange.mjs: append-rebuttals refused seat A rebuttals'].join(String.fromCharCode(10));
  assert.equal(failureDetail(text), ' | reasons: append-rebuttals: line 12: claim id P1 survives inside an Evidence fence | append-rebuttals: line 31: claim id P2 survives inside an Evidence fence');
  assert.equal(failureDetail('only one line'), '');
  assert.equal(failureDetail(['exchange: x', 'last'].join(String.fromCharCode(10))), '');
});

test('self-review fixes: a crash shows its error line, not stack frames; a long reason line is cut; the FAILED line survives the ten-line cap', () => {
  const nl = String.fromCharCode(10);
  const crash = ['preflight.mjs: unexpected failure: TypeError: boom', '    at a (file:///x/f.mjs:1:1)', '    at b (file:///x/f.mjs:2:2)', '    at async Promise.all (index 0)', '    at new Promise (<anonymous>)', '    at Array.map (<anonymous>)', '    at node:internal/main/run_main_module:28:49'].join(nl);
  assert.equal(tail(crash), 'preflight.mjs: unexpected failure: TypeError: boom');
  assert.equal(failureDetail(crash), '');
  const long = failureDetail(['codex-dispatch: started', 'x'.repeat(900), 'codex-dispatch: exited 1'].join(nl));
  assert.ok(long.length < 200, long.length);
  const written = [];
  print({ lines: [...Array.from({ length: 12 }, (_, i) => `progress ${i + 1}`), 'FAILED exchange: boom'], next: 'fix it' }, { write: (t) => written.push(t) });
  const out = written.join('').split(nl).filter(Boolean);
  assert.equal(out.length, 11, 'ten lines plus next:');
  assert.equal(out.at(-2), 'FAILED exchange: boom');
  assert.equal(out.at(-3), '... 4 more line(s) omitted');
});

test('self-review fixes: a reader that closes stdout early does not turn a failure into exit 0', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-run-epipe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../review-run.mjs', import.meta.url));
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    child.on('close', resolve);
  });
  assert.equal(await run(['bogus']), 2);
  assert.equal(await run(['phase1', '--run-dir', dir, '--wait']), 1);
});

test('a byte-order mark before the first heading of a native seat file does not hide its claims (a Windows editor writes one)', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1 - x\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const bom = String.fromCharCode(0xfeff);
  await fs.writeFile(path.join(s.run, 'phase2', 'A-rebuttals-raw.md'), bom + '### P1\nCONCEDE\n');
  const done = await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A');
  assert.equal(done.code, 0, done.out);
});

test('a native seat whose agent has finished but whose file has no claim heading is a failure that says why, not a wait', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1 - x\nclaim\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase2', 'A-rebuttals-raw.md'), '## Rebuttals (from A) of B claims\n\nno heading below\n');
  const transcript = path.join(s.base, 'agent-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'end_turn' })].join('\n') + '\n');
  const failed = await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', 'A=' + transcript);
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /its agent finished, but .*A-rebuttals-raw\.md has no claim heading \("### P<n>"\); a byte-order mark/);
  const working = await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(working.code, 1, 'the remembered agent id keeps the verdict on a rerun');
});

test('audit --finish before audit --prepare says to run --prepare first, not a raw file error', async (t) => {
  const s = await setup(t);
  const early = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(early.code, 1, early.out);
  assert.match(early.out, /FAILED audit prepare: the staged audit folder .* is missing or incomplete: run review-run audit --prepare first/);
  assert.doesNotMatch(early.out, /ENOENT/);
});
