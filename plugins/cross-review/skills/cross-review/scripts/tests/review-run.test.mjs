import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readRunDescriptor, writeRunDescriptor } from '../run-descriptor.mjs';
import { parseArgs, run as runInProcess, clockLine, seatDepth, shallowSeatNote, execFailureCount, formatElapsed, seatStatusLines, otherPendingSeats, warnExtraRepos, failureDetail, tail, print } from '../review-run.mjs';
import { computeSnapshotHash } from '../preflight.mjs';
import { runStep as relabelStep } from '../blind-relabel.mjs';
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
if (m) fs.writeFileSync(path.join(outDir, role + (phase === 'phase1' ? '-findings.md' : '-rebuttals-raw.md')), (role === 'A' && phase === 'phase1' && ctl.finalA) || '# findings from ' + role + '\\n' + (phase === 'phase1' ? '\\n## No findings\\n\\nBlocked: none\\n' : ''));
else if (!ctl.auditorWritesNothing) fs.writeFileSync(path.join(outDir, 'findings.audit.json'), '{"fake":true}\\n');
fs.writeFileSync(path.join(path.dirname(brief), 'result.json'), JSON.stringify({
  status: 'completed', sessionId: 'sess-' + role, modelResolved: ctl.resolved && role in ctl.resolved ? ctl.resolved[role] : 'resolved-' + role, worktreePath: ctl.worktrees?.[role] ?? null,
  touchedFiles: ctl.touched && role in ctl.touched ? ctl.touched[role] : [], ...(m ? null : ctl.recordAuditor),
}));
`,
  'codex-dispatch.mjs': `
if (argv[0] === '--wait') process.exit(ctl.codexWait ?? 0);
const brief = get('--brief');
const out = get('--final-message-out');
const role = /[\\\\/]A-(findings|rebuttals)/.test(out) ? 'A' : 'B';
const resolved = ctl.codexResolved && role in ctl.codexResolved ? ctl.codexResolved[role] : get('--model');
fs.writeFileSync(path.join(path.dirname(brief), 'result.json'), JSON.stringify({ status: 'completed', threadId: 'thread-' + role, worktreePath: null, modelResolved: resolved, ...(role === 'B' ? ctl.recordB : null) }));
fs.writeFileSync(out, path.basename(out) === 'findings.audit.json' ? '{"fake":true}\\n' : (role === 'B' && ctl.finalB) || '# findings from ' + role + '\\n' + (/-findings\\.md$/.test(out) ? '\\n## No findings\\n\\nBlocked: none\\n' : ''));
`,
  'build-brief.mjs': `
if (ctl.failBuild === get('--mode')) { process.stderr.write('build-brief: refused\\n'); process.exit(1); }
fs.mkdirSync(path.dirname(get('--out')), { recursive: true });
fs.writeFileSync(get('--out'), 'brief ' + get('--mode') + '\\n');
`,
  'blind-relabel.mjs': `
const sub = argv[0];
if (sub === 'validate' && ctl.validateExit) { process.stderr.write('validate: claim A1 lacks Evidence\\n'); process.exit(ctl.validateExit); }
if (sub === 'validate' && ctl.validateWarn) process.stderr.write('blind-relabel: WARNING: seat A A1 is HIGH with no "Trigger:" line\\nblind-relabel: WARNING: seat B B2 cites x.py:900\\n');
if (sub === 'scan' && ctl.scanExit) { process.stderr.write('scan: IDENTITY hit\\n'); process.exit(ctl.scanExit); }
if (sub === 'flip') fs.writeFileSync(get('--out'), '{"A":"X","B":"Y"}\\n');
if (sub === 'audit-prep') {
  fs.mkdirSync(get('--out-dir'), { recursive: true });
  fs.writeFileSync(path.join(get('--out-dir'), 'task-packet.md'), 'packet\\n');
  fs.writeFileSync(path.join(get('--out-dir'), 'X-findings.md'), ctl.emptyStaged ? '' : ctl.zeroClaims ? '## No findings\\n' : '## X1\\nclaim\\n');
  fs.writeFileSync(path.join(get('--out-dir'), 'Y-findings.md'), ctl.emptyStaged ? '' : ctl.zeroClaims ? '## No findings\\n' : '## Y1\\nclaim\\n');
  fs.mkdirSync(path.dirname(get('--breakdown-out')), { recursive: true });
  fs.writeFileSync(get('--breakdown-out'), JSON.stringify({ falsificationBreakdown: { high_or_critical: 3, disputed: ctl.qualified ?? 0, conceded: 1, unaddressed: 0, ...(ctl.qualifiedIds ? { disputed_ids: ctl.qualifiedIds } : {}) } }) + '\\n');
}
if (sub === 'translate' && ctl.translateExit) { process.stderr.write((ctl.translateMessage ?? 'translate: prose field contains a claim ID') + '\\n'); process.exit(ctl.translateExit); }
if (sub === 'translate' || sub === 'scorecard') fs.writeFileSync(get('--out'), 'out\\n');
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
    flags: { falsification: false, mode: 'adversarial', ...flags }, fingerprint,
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
    const io = { stdout: { write: (chunk) => { out += chunk; } }, stderr: { write: (chunk) => { err += chunk; } }, steps: inProcessRunner(hook), skill: state.runAs };
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
  assert.deepEqual(parseArgs(['phase1', '--run-dir', 'r', '--start']), { command: 'phase1', runDir: 'r', half: 'start', maxWait: 480, nativeDone: [], nativeAgents: {}, acceptMissingVerifiers: false, acceptDrift: false, local: false, incompleteSeat: null });
  assert.equal(parseArgs(['audit', '--run-dir', 'r', '--finish', '--accept-drift']).acceptDrift, true);
  // Field feedback S6: old notes still pass the removed flag; the error says what replaced it.
  assert.throws(() => parseArgs(['audit', '--run-dir', 'r', '--prepare', '--audit-depth', 'full']), /--audit-depth is gone: every audit re-checks every claim/);
  assert.equal(parseArgs(['phase1', '--run-dir', 'r', '--wait', '--accept-drift']).acceptDrift, true);
  assert.equal(parseArgs(['phase2', '--run-dir', 'r', '--wait', '--accept-drift']).acceptDrift, true);
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
  assert.equal(await fs.readFile(path.join(s.run, 'phase1', 'A-findings.md'), 'utf8'), '# findings from A\n\n## No findings\n\nBlocked: none\n');
  assert.equal(await fs.readFile(path.join(s.run, 'phase1', 'B-findings.md'), 'utf8'), '# findings from B\n\n## No findings\n\nBlocked: none\n');
  const wait = (await s.calls()).slice(4);
  assert.deepEqual(names(wait), ['claude-dispatch:--wait', 'codex-dispatch:--wait', 'blind-relabel:validate']);
  assert.equal(s.flag(wait[2], '--phase1-dir'), path.join(s.run, 'phase1'));
  assert.equal(s.flag(wait[2], '--packet'), path.join(s.run, 'task-packet.md'));
  assert.equal(s.flag((await s.calls()).find((c) => c.script === 'build-brief.mjs'), '--run-dir'), s.run, 'the seat brief checks the packet against the run folder before any seat runs');
  assert.ok(r.lines.some((l) => /published A-findings\.md/.test(l)));
  assert.match(r.lines.at(-1), /^next: run: review-run phase2 --run-dir .* --start$/);
  assert.ok(r.lines.includes('validate Phase 1: clean'));
  await s.ctl({ validateWarn: true });
  const again = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(again.code, 0, 'a second --wait republishes nothing and still passes');
  assert.ok(again.lines.includes('validate Phase 1: clean, 2 warning(s), e.g. seat A A1 is HIGH with no "Trigger:" line'), 'validate warnings are not dropped');
  // Round 5 F8: a repeated --start that starts no seat keeps the "Phase 1 finished" record.
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: phase1 finished; next: /);
  const repeat = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.ok(repeat.lines.filter((l) => /already started/.test(l)).length === 2, repeat.out);
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: phase1 finished; next: /);
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
  assert.match(r.lines.at(-1), /^next: seat A \(claude\) is still running; rerun this command: review-run phase1 --run-dir .* --wait; do not start phase2 until this exits 0$/);
});

test('a native seat is waited for by its output file and a missing file exits 3', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const waiting = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3);
  assert.match(waiting.lines.at(-1), /native seat A has not written .*A-findings\.md/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 - x\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
});

test('a native seat with a claim in its file is not done until --native-done names it: exit 3 and no validate', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 - partial\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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
  // Field northwind-1a: a repeated flag adds to the list instead of keeping only the last one.
  assert.deepEqual(parseArgs(['phase2', '--run-dir', 'r', '--wait', '--native-done', 'A', '--native-done', 'B']).nativeDone, ['A', 'B']);
  assert.deepEqual(parseArgs(['phase2', '--run-dir', 'r', '--wait', '--native-done', 'A', '--native-done', 'A,B']).nativeDone, ['A', 'B']);
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--wait', '--native-done', 'A', '--native-done', ',']), /--native-done takes seat letters/);
});

test('a native seat with the No findings marker is finished; a peer-letter heading is not a claim for this seat', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## B1 - wrong letter\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1')).code, 3);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## No findings\n\nBlocked: none\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
});

test('a native seat in Phase 2 is finished only with a ### P block; a header-only file exits 3', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1 - x\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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
    for (const role of ['A', 'B']) await fs.writeFile(path.join(s.run, 'phase1', `${role}-findings.md`), `## ${role}1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n`);
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

test('restructure round 2 F10: phase2 --wait --incomplete-seat finishes the exchange without a seat that cannot be resumed', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  // Restructure round 3 F5: the declared seat's CLI is still working on its exchange: it is stopped before the finish.
  const { processStartMs, processStartToken, processExists } = await import('../detach-utils.mjs');
  const { spawn } = await import('node:child_process');
  // A real seat CLI leads its own process group on POSIX (spawnCli, detached), which the stop signals.
  const stuck = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  t.after(() => { try { stuck.kill(); } catch { /* already gone */ } });
  await new Promise((r) => stuck.once('spawn', r));
  const recordA = path.join(s.run, 'phase2', 'A', 'result.json');
  await fs.writeFile(recordA, JSON.stringify({ status: 'running', sessionId: 'sess-A', childPid: stuck.pid, childStartedAt: new Date(processStartMs(stuck.pid) ?? Date.now()).toISOString(), childStartToken: processStartToken(stuck.pid) }));
  const before = (await s.calls()).length;
  const wait = await s.rr('phase2', '--run-dir', s.run, '--wait', '--incomplete-seat', 'A');
  assert.equal(wait.code, 0, wait.out + wait.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls), ['codex-dispatch:--wait', 'exchange:finish'], 'seat A is not waited for');
  assert.equal(s.flag(calls.at(-1), '--incomplete-seats'), 'A');
  assert.ok(wait.lines.some((l) => /seat A: declared incomplete \(--incomplete-seat\)/.test(l)), wait.out);
  assert.ok(wait.lines.some((l) => /seat A: its Phase 2 CLI was still running and was stopped/.test(l)), wait.out);
  for (let i = 0; i < 50 && processExists(stuck.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(processExists(stuck.pid), false, 'the declared seat\'s CLI is gone');
  for (const bad of [['phase2', '--run-dir', s.run, '--start', '--incomplete-seat', 'A'], ['phase1', '--run-dir', s.run, '--wait', '--incomplete-seat', 'A'], ['phase2', '--run-dir', s.run, '--wait', '--incomplete-seat', 'C']]) {
    assert.equal((await s.rr(...bad)).code, 2, bad.join(' '));
  }
});

test('run.json env settings reach every CLI dispatch as flags: phase1 start, the phase2 resume and the auditor', async (t) => {
  const s = await setup(t, {
    seatA: { env: { pass: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION'], apiKey: true } },
    seatB: { env: { mode: 'inherit', pass: ['OPENAI_BASE_URL'] } },
    auditor: { env: { pass: ['CLAUDE_CODE_USE_BEDROCK'] } },
  });
  const envOf = (call) => ({ mode: call.argv.includes('--env-mode') ? s.flag(call, '--env-mode') : null, pass: call.argv.includes('--env-passthrough') ? s.flag(call, '--env-passthrough') : null, apiKey: call.argv.includes('--use-api-key') });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const starts = (await s.calls()).filter((c) => c.script.endsWith('dispatch.mjs') && c.argv.includes('--detach'));
  assert.equal(starts.length, 4);
  for (const call of starts.filter((c) => c.script === 'claude-dispatch.mjs')) assert.deepEqual(envOf(call), { mode: null, pass: 'CLAUDE_CODE_USE_BEDROCK,AWS_REGION', apiKey: true });
  for (const call of starts.filter((c) => c.script === 'codex-dispatch.mjs')) assert.deepEqual(envOf(call), { mode: 'inherit', pass: 'OPENAI_BASE_URL', apiKey: false });
  assert.ok(starts.some((c) => c.script === 'codex-dispatch.mjs' && c.argv.includes('--session')), 'the resume carries the setting too');
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  const before = (await s.calls()).length;
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  const auditor = (await s.calls()).slice(before).find((c) => c.script === 'claude-dispatch.mjs' && c.argv.includes('--detach'));
  assert.deepEqual(envOf(auditor), { mode: null, pass: 'CLAUDE_CODE_USE_BEDROCK', apiKey: false });
});

// The real dispatchers, started detached by review-run itself, against fake CLIs that answer with the environment they got.
test('run.json env: named variables reach a fake CLI and others do not, detached in Phase 1, resumed in Phase 2 and in the foreground [slow]', async (t) => {
  const pair = CURRENT === 'pair-review';
  const s = await setup(t, {
    skill: CURRENT,
    seatA: { env: { pass: ['SEAT_A_VAR'], apiKey: true } },
    seatB: pair ? { provider: 'anthropic', runtime: 'claude', model: 'model-B', env: { pass: ['SEAT_B_VAR'] } } : { env: { pass: ['SEAT_B_VAR'] } },
  });
  const hook = path.join(s.base, 'env-hook');
  const bin = path.join(s.base, 'bin');
  await fs.mkdir(hook);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(hook, 'build-brief.mjs'), COMMON + "fs.mkdirSync(path.dirname(get('--out')), { recursive: true }); fs.writeFileSync(get('--out'), '{}');\n");
  await fs.writeFile(path.join(hook, 'exchange.mjs'), `${COMMON}
const p2 = path.join(get('--run-dir'), 'phase2');
fs.mkdirSync(path.join(p2, 'A'), { recursive: true });
fs.writeFileSync(path.join(p2, 'A', 'delta-brief.txt'), '{}');
process.stdout.write(JSON.stringify({ briefs: { A: path.join(p2, 'A', 'delta-brief.txt'), B: null }, rebuttals: { A: null, B: null }, skipped: { B: 'fixture' } }));
`);
  await fs.copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs'), path.join(bin, 'fake-claude.mjs'));
  await fs.writeFile(path.join(bin, 'fake-codex.mjs'), [
    "if (process.argv.includes('mcp')) { process.stdout.write('[]\\n'); process.exit(0); }",
    "let input = ''; for await (const c of process.stdin) input += c;",
    "const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
    "say({ type: 'thread.started', thread_id: 'env-thread' });",
    "say({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ env: process.env }) } });",
    "say({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });",
    '',
  ].join('\n'));
  for (const [name, fake] of [['claude', 'fake-claude.mjs'], ['codex', 'fake-codex.mjs']]) {
    await fs.writeFile(path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name), process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${path.join(bin, fake)}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, fake)}" "$@"\n`, { mode: 0o755 });
  }
  const gitDir = path.dirname(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: [bin, gitDir].join(path.delimiter), REVIEW_DETACH_MODE: 'plain', SEAT_A_VAR: 'a', SEAT_B_VAR: 'b', SEAT_OTHER_VAR: 'other', ANTHROPIC_API_KEY: 'fixture-key' });
  // The real dispatchers run as child processes with this environment; build-brief and exchange are fakes.
  const steps = (name, argv) => spawnSync(process.execPath, [path.join(name.endsWith('-dispatch.mjs') ? SCRIPTS : hook, name), ...argv], { encoding: 'utf8', env, timeout: 120000 });
  const reviewRun = async (...args) => {
    let stdout = '';
    let stderr = '';
    const status = await runInProcess(args, { stdout: { write: (c) => { stdout += c; } }, stderr: { write: (c) => { stderr += c; } }, steps, skill: s.state.runAs });
    return { status, stdout, stderr };
  };
  // Up to 10 minutes: under release-check's full parallel load a detached Windows worker took over 3 minutes to finish.
  const settled = async (file) => {
    for (let i = 0; i < 3000; i++) {
      const record = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
      if (record.status && record.status !== 'running') return record;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`${file} never settled`);
  };
  const seen = (record) => JSON.parse(record.finalMessage).env;
  const start = await reviewRun('phase1', '--run-dir', s.run, '--start');
  assert.equal(start.status, 0, start.stdout + start.stderr);
  const a1 = await settled(path.join(s.run, 'phase1', 'A', 'result.json'));
  const b1 = await settled(path.join(s.run, 'phase1', 'B', 'result.json'));
  assert.equal(a1.status, 'completed', a1.error);
  assert.equal(b1.status, 'completed', b1.error);
  assert.equal(a1.detached, true);
  const [envA, envB] = [seen(a1), seen(b1)];
  assert.deepEqual([envA.SEAT_A_VAR, envA.SEAT_B_VAR, envA.SEAT_OTHER_VAR, envA.ANTHROPIC_API_KEY], ['a', undefined, undefined, 'fixture-key']);
  assert.deepEqual([envB.SEAT_A_VAR, envB.SEAT_B_VAR, envB.SEAT_OTHER_VAR, envB.ANTHROPIC_API_KEY], [undefined, 'b', undefined, undefined]);
  // phase2 --start before phase1 --wait has finished refuses and names the wait, instead of failing in exchange prepare.
  const early = await reviewRun('phase2', '--run-dir', s.run, '--start');
  assert.notEqual(early.status, 0);
  assert.match(early.stdout + early.stderr, /Phase 1 has not finished[\s\S]*a run started before this version has no marker[\s\S]*phase1 --run-dir .* --wait/);
  // The fake seats write no findings for phase1 --wait to validate, so Phase 1 is marked finished here.
  await fs.writeFile(path.join(s.run, 'phase1-done.json'), '{}\n');
  // Phase 2 resumes seat A on its Phase 1 session through the same setting.
  const resume = await reviewRun('phase2', '--run-dir', s.run, '--start');
  assert.equal(resume.status, 0, resume.stdout + resume.stderr);
  const a2 = await settled(path.join(s.run, 'phase2', 'A', 'result.json'));
  assert.equal(a2.status, 'completed', a2.error);
  assert.ok(JSON.parse(a2.finalMessage).argv.includes('--resume'), 'the seat was resumed');
  assert.deepEqual([seen(a2).SEAT_A_VAR, seen(a2).SEAT_OTHER_VAR, seen(a2).ANTHROPIC_API_KEY], ['a', undefined, 'fixture-key']);
  // The dispatcher in the foreground with the flags review-run builds from the same setting, without the key opt-in.
  const folder = path.join(s.base, 'foreground');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'brief.txt'), '{}');
  const fg = spawnSync(process.execPath, [path.join(SCRIPTS, 'claude-dispatch.mjs'), '--brief', path.join(folder, 'brief.txt'), '--cd', s.target, '--model', 'model-A', '--env-passthrough', 'SEAT_A_VAR', '--timeout', '60'], { encoding: 'utf8', env, timeout: 90000 });
  assert.equal(fg.status, 0, fg.stderr);
  const own = seen(JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8')));
  assert.deepEqual([own.SEAT_A_VAR, own.SEAT_OTHER_VAR, own.ANTHROPIC_API_KEY], ['a', undefined, undefined]);
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
  assert.ok(!again.lines.some((l) => /^flip:/.test(l)), 'refused before any step runs');
});

async function prepared(t, options) {
  const s = await setup(t, options);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  return s;
}

test('audit --finish with a CLI auditor: the full-audit brief, dispatch, translate, scorecard, clear-cache, in the documented order', async (t) => {
  const s = await prepared(t, { flags: { falsification: true } });
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const before = (await s.calls()).length;
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 0, r.out + r.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls), ['blind-relabel:scan', 'build-brief:--mode', 'claude-dispatch:start', 'claude-dispatch:--wait', 'blind-relabel:translate', 'blind-relabel:scorecard', 'blind-relabel:clear-cache']);
  const [, brief, dispatch, , translate] = calls;
  assert.equal(s.flag(brief, '--mode'), 'auditor');
  assert.equal(brief.argv.includes('--audit-depth'), false, 'the auditor brief has one depth: every claim');
  assert.equal(s.flag(brief, '--out'), path.join(`${s.run}-audit-dispatch`, 'auditor-brief.txt'));
  assert.equal(s.flag(brief, '--output-path'), path.join(`${s.run}-audit-input`, 'findings.audit.json'));
  assert.equal(s.flag(brief, '--run-dir'), s.run);
  assert.equal(await fs.readFile(path.join(`${s.run}-audit-input`, 'verification-X1.md'), 'utf8'), 'verified\n', 'verification files are staged before the brief is built');
  assert.equal(s.flag(dispatch, '--out-dir'), `${s.run}-audit-input`);
  assert.equal(s.flag(translate, '--audit-depth'), 'full');
  assert.equal(s.flag(translate, '--verification-dir'), path.join(s.run, 'phase3'));
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"fake":true}\n');
  assert.match(r.lines.at(-1), /^next: run: review-run manifest --run-dir .*, then review-run report --run-dir /);
});

test('audit --finish after a refused translate and a corrected auditor file keeps the refused copy and continues', async (t) => {
  const s = await prepared(t);
  await s.ctl({ translateExit: 1 });
  const refused = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(refused.code, 1, refused.out + refused.err);
  // The refusal is the auditor's file, named as such, with the reason; the refused copy is moved aside at once.
  assert.match(refused.lines.at(-2), /^FAILED auditor output: the auditor's file was refused \(kept as findings\.audit\.attempt-1\.json\): translate: prose field contains a claim ID/);
  assert.match(refused.lines.at(-1), /dispatches the auditor again/);
  const auditFile = path.join(s.run, 'phase3', 'findings.audit.json');
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.attempt-1.json'), 'utf8'), '{"fake":true}\n');
  await assert.rejects(fs.access(auditFile));
  assert.match(await fs.readFile(path.join(s.run, 'phase3', 'prompt-auditor-fix.txt'), 'utf8'), /was refused: translate: prose field contains a claim ID\..*rewrite it in one write/);
  // Round 6: a long reason reaches the auditor whole (the step line cuts it at 220 characters; its instruction is at the end).
  const long = 'blind-relabel: prose field "findings.0.suggested_fix.0" contains "X1", an anonymous claim ID of this run -- prose fields are copied verbatim (never ID-rewritten), so this would publish an unresolved label; cite claims only in origins/peer_responses/verifications and re-run the auditor output';
  // Field run: the CLI auditor's result.json and output are moved aside, so a plain rerun dispatches it again.
  const dispatched = async () => (await s.calls()).filter((c) => c.script === 'claude-dispatch.mjs' && c.argv?.includes('--brief')).length;
  const before = await dispatched();
  await s.ctl({ translateExit: 1, translateMessage: long });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 1);
  assert.equal(await dispatched(), before + 1, 'the rerun dispatched the auditor again');
  assert.ok((await fs.readFile(path.join(s.run, 'phase3', 'prompt-auditor-fix.txt'), 'utf8')).includes(`was refused: ${long.slice('blind-relabel: '.length)}. Read the Output`));
  await s.ctl({});
  const done = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal(await dispatched(), before + 2);
  assert.ok(await fs.readFile(auditFile, 'utf8'));
});

test('a refused CLI auditor dispatched again in a new temporary worktree: audit --finish and manifest both succeed and count both calls [slow]', async (t) => {
  const s = await prepared(t, { git: true });
  const record = (input) => ({ modelRequested: 'model-auditor', isolated: true, usageSemantics: 'per-call', usage: { input_tokens: input }, durationMs: input * 10 });
  const wt = (name) => path.join(s.base, name);
  await s.ctl({ translateExit: 1, worktrees: { auditor: wt('rv-aaaa1111') }, recordAuditor: record(900) });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 1);
  await s.ctl({ worktrees: { auditor: wt('rv-bbbb2222') }, recordAuditor: record(100) });
  const done = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal((await dispatches(s)).length, 2);
  let err = '';
  const code = await runInProcess(['manifest', '--run-dir', s.run], { stdout: { write: () => {} }, stderr: { write: (c) => { err += c; } } });
  assert.equal(code, 0, err);
  const auditor = JSON.parse(await fs.readFile(path.join(s.run, 'manifest.json'), 'utf8')).actors.find((a) => a.role === 'auditor');
  assert.deepEqual([auditor.usage.input_tokens, auditor.duration_ms, auditor.worktreePath], [1000, 10000, wt('rv-bbbb2222')]);
  assert.doesNotMatch(err, /not passed to --reviewer-result/);
});

test('audit --finish with a native auditor whose file translate refuses: next names the fix message for the agent', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 0);
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  await s.ctl({ translateExit: 1 });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-1), /^next: send the auditor agent the message in .*prompt-auditor-fix\.txt \(never edit its file yourself\)/);
  await assert.rejects(fs.access(auditOut(s)), 'the refused file is moved aside, so a rerun waits for the rewritten one');
});

test('audit --finish: the fix message keeps the blind labels (X/Y), and a crash of translate is not sent back to the auditor', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 0);
  await fs.mkdir(path.join(s.run, 'phase3-private'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase3-private', 'seat-to-audit-label.json'), JSON.stringify({ A: 'Y', B: 'X' }));
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  await s.ctl({ translateExit: 1, translateMessage: 'blind-relabel: claim "B3" appears as an origin of more than one finding' });
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 1, r.out);
  const fix = await fs.readFile(path.join(s.run, 'phase3', 'prompt-auditor-fix.txt'), 'utf8');
  assert.match(fix, /claim "X3" appears as an origin/);
  // A whole word: the random temp folder name in the message can hold the same letters ("review run rB3w0m").
  assert.doesNotMatch(fix, /\bB3\b/);
  // Mac round 4 F6: a seat file name is mapped to its audit label too, and a reason that still names a seat is never sent.
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  await s.ctl({ translateExit: 1, translateMessage: 'blind-relabel: translated origin "A9" has no "## A9" heading in A-findings.md; refusing' });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 1);
  const mapped = await fs.readFile(path.join(s.run, 'phase3', 'prompt-auditor-fix.txt'), 'utf8');
  assert.match(mapped, /origin "Y9" has no "## Y9" heading in Y-findings\.md/);
  assert.doesNotMatch(mapped, /\b[AB]9\b|\b[AB]-findings\.md/);
  await fs.rm(path.join(s.run, 'phase3', 'prompt-auditor-fix.txt'));
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  await s.ctl({ translateExit: 1, translateMessage: 'blind-relabel: the claim of seat A is malformed' });
  const named = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(named.code, 1);
  assert.match(named.out, /names a seat, so it is not sent back to the auditor/);
  await assert.rejects(fs.access(path.join(s.run, 'phase3', 'prompt-auditor-fix.txt')), 'no fix prompt that names a seat');
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  await s.ctl({ translateExit: 1, translateMessage: 'blind-relabel: unexpected failure: boom' });
  const crash = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.match(crash.lines.at(-2), /^FAILED translate: /);
  assert.match(crash.lines.at(-1), /^next: fix "translate"/);
});

test('audit --finish removes the fix message once translate passes, so a later crash is not reported as a refused auditor file', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 0);
  const fix = path.join(s.run, 'phase3', 'prompt-auditor-fix.txt');
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  await s.ctl({ translateExit: 1 });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 1);
  assert.ok(fsSync.existsSync(fix), 'the refusal wrote the fix message');
  await fs.writeFile(auditOut(s), '{"native":"rewritten"}\n');
  await s.ctl({});
  const done = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal(fsSync.existsSync(fix), false, 'a passed translate removes the fix message');
  // A resumed auditor's changed file archives the findings; translate then crashes, which is not the auditor's to fix.
  await fs.writeFile(auditOut(s), '{"native":"resumed"}\n');
  await s.ctl({ translateExit: 1, translateMessage: 'blind-relabel: unexpected failure: boom' });
  const crash = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.match(crash.lines.at(-2), /^FAILED translate: /);
  assert.equal(fsSync.existsSync(path.join(s.run, 'phase3', 'findings.json')), false, 'the earlier findings were archived');
  assert.equal(fsSync.existsSync(fix), false);
  const { loadRun } = await import('../build-report.mjs');
  await fs.mkdir(path.join(s.run, 'phase1'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 x\nSeverity: LOW\nSame shape elsewhere: none found\n\n## Checks performed\n- ok.\nBlocked: none\n');
  await fs.writeFile(path.join(s.run, 'phase1', 'B-findings.md'), '# Seat B findings\n\n## No findings\n\nBlocked: none\n');
  const report = await loadRun(s.run);
  assert.equal(report.status, 'INCOMPLETE');
  assert.ok(!report.caveats.some((c) => c.startsWith("The auditor's file was refused")), report.caveats.join(' | '));
});

test('audit --finish without falsification passes no --verification-dir; translate reads a new run as full and an older run by its own depth [slow]', async (t) => {
  const s = await prepared(t);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  const translate = (await s.calls()).find((c) => c.argv[0] === 'translate');
  assert.equal(translate.argv.includes('--verification-dir'), false);
  assert.equal(s.flag(translate, '--audit-depth'), 'full');
  const old = await prepared(t, { flags: { auditDepth: 'light' } });
  assert.equal((await old.rr('audit', '--run-dir', old.run, '--finish')).code, 0);
  assert.equal(old.flag((await old.calls()).find((c) => c.argv[0] === 'translate'), '--audit-depth'), 'light', 'a run.json from an older run keeps its depth');
  // Restructure round 1 F7: a deep verify the user asked for after the audit (the run started without falsification)
  // is staged and read by translate; with no verifier file nothing is required.
  const late = await prepared(t);
  await fs.writeFile(path.join(late.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const r = await late.rr('audit', '--run-dir', late.run, '--finish');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(late.flag((await late.calls()).find((c) => c.argv[0] === 'translate'), '--verification-dir'), path.join(late.run, 'phase3'));
  assert.equal(await fs.readFile(path.join(`${late.run}-audit-input`, 'verification-X1.md'), 'utf8'), 'verified\n');
  assert.equal(r.lines.some((l) => /verification file\(s\) in phase3 are ignored/.test(l)), false);
  // A deep verify after a finished audit needs a native auditor, which can be resumed (phase-3 file; that route is the
  // restructure round 3 F6 test); with a CLI auditor the step stops and says to run the review again with falsification.
  const after = await prepared(t);
  assert.equal((await after.rr('audit', '--run-dir', after.run, '--finish')).code, 0);
  await fs.writeFile(path.join(after.run, 'phase3', 'findings.json'), '{"earlier":true}\n');
  await fs.writeFile(path.join(after.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const rerun = await after.rr('audit', '--run-dir', after.run, '--finish');
  assert.equal(rerun.code, 1, rerun.out + rerun.err);
  assert.match(rerun.out, /FAILED stage verification: verification-X1\.md staged after the audit, but a CLI auditor cannot be resumed to read them: run the review again with falsification/);
  assert.equal(await fs.readFile(path.join(after.run, 'phase3', 'findings.json'), 'utf8'), '{"earlier":true}\n', 'the finished findings stay');
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
  // Restructure round 2 F1: after the audit finished, a changed file (a resumed auditor) waits for --native-done again.
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0, 'an unchanged file needs nothing new');
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"native":"resumed, half written"}\n');
  const early = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(early.code, 3, early.out);
  assert.match(early.out, /changed since the audit finished \(a resumed auditor\) but a file alone cannot show the agent finished/);
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"native":true}\n', 'the earlier copy is untouched');
  const done = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(done.code, 0, done.out + done.err);
  assert.equal(await fs.readFile(path.join(s.run, 'phase3', 'findings.audit.json'), 'utf8'), '{"native":"resumed, half written"}\n');
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
  const again = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(again.code, 0, again.out + again.err);
  assert.ok(again.lines.includes('worktrees: removed 0'), 'a rerun counts what it removed, not what was recorded');
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
  // Overnight queue: no run.json means the host preflight refused or never ran; the next line says to run it.
  assert.match(r.lines.at(-1), /^next: run\.json is written by the host preflight: run preflight\.mjs --host <host> .*--run-dir .*, then rerun: review-run phase1/);
  await fs.writeFile(path.join(s.run, 'run.json'), '{ not json');
  assert.match((await s.rr('phase1', '--run-dir', s.run, '--start')).lines.at(-1), /^next: fix "run\.json"/, 'a broken run.json is still "fix"');
});

test('the CLI entry runs: status of a fresh run folder, and a usage error with exit 2; REVIEW_RUN_SCRIPTS_DIR no longer replaces a step [slow]', async (t) => {
  const s = await setup(t, { skill: CURRENT, ...(CURRENT === 'pair-review' ? { seatB: { provider: 'anthropic', runtime: 'claude', model: 'model-B' } } : {}) });
  const cli = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'review-run.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_RUN_SCRIPTS_DIR: s.hook } });
  const status = cli('status', '--run-dir', s.run);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /: not started; next: phase1 --start/);
  const bad = cli('phase1', '--run-dir', s.run);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /phase1 needs one of --start \/ --wait/);
  assert.equal((await s.calls()).length, 0, 'no fake step ran');
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

test('a CLI seat an earlier --start never started (brief, no result.json) is dispatched by the wait, in Phase 1 and Phase 2', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.rm(path.join(s.run, 'phase1', 'B', 'result.json'));
  let before = (await s.calls()).length;
  const w1 = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(w1.code, 0, w1.out + w1.err);
  assert.ok(w1.lines.some((l) => /^seat B: not started by an earlier --start \(no result\.json\); dispatched now/.test(l)), w1.out);
  assert.deepEqual(names((await s.calls()).slice(before)).slice(0, 4), ['claude-dispatch:--wait', 'codex-dispatch:start', 'codex-dispatch:--wait', 'blind-relabel:validate']);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  // Seat A's own copy of its delta brief was never made either: the wait copies it from the shared brief.
  await fs.rm(path.join(s.run, 'phase2', 'A'), { recursive: true });
  await fs.rm(path.join(s.run, 'phase2', 'B', 'result.json'));
  before = (await s.calls()).length;
  const w2 = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(w2.code, 0, w2.out + w2.err);
  const calls = (await s.calls()).slice(before);
  assert.deepEqual(names(calls), ['claude-dispatch:start', 'claude-dispatch:--wait', 'codex-dispatch:start', 'codex-dispatch:--wait', 'exchange:finish']);
  assert.equal(s.flag(calls[0], '--brief'), path.join(s.run, 'phase2', 'A', 'delta-brief.txt'));
  assert.equal(await fs.readFile(path.join(s.run, 'phase2', 'A', 'delta-brief.txt'), 'utf8'), 'delta brief\n');
});

test('review rules: --rules <run-dir>/review-rules.md goes to the seat and auditor briefs only when run.json has reviewRules', async (t) => {
  const briefs = async (s) => (await s.calls()).filter((c) => c.script === 'build-brief.mjs');
  const plain = await setup(t);
  for (const half of [['phase1', '--start'], ['phase1', '--wait'], ['phase2', '--start'], ['phase2', '--wait']]) assert.equal((await plain.rr(half[0], '--run-dir', plain.run, half[1])).code, 0);
  assert.equal((await plain.rr('audit', '--run-dir', plain.run, '--prepare')).code, 0);
  assert.ok((await briefs(plain)).every((c) => !c.argv.includes('--rules')), 'no rules, no flag');
  const s = await setup(t);
  const file = path.join(s.run, 'run.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), reviewRules: { mode: 'head', sha256: 'x', changedByTarget: false, files: [] } }));
  for (const half of [['phase1', '--start'], ['phase1', '--wait'], ['phase2', '--start'], ['phase2', '--wait']]) assert.equal((await s.rr(half[0], '--run-dir', s.run, half[1])).code, 0);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  const withRules = (await briefs(s)).filter((c) => ['phase1', 'auditor'].includes(s.flag(c, '--mode')));
  assert.ok(withRules.length >= 2);
  for (const c of withRules) assert.equal(s.flag(c, '--rules'), path.join(s.run, 'review-rules.md'), s.flag(c, '--mode'));
});

test('audit --prepare: empty staged findings files are not a clean zero-claim review; the auditor still runs', async (t) => {
  const s = await setup(t);
  await s.ctl({ emptyStaged: true });
  const r = await s.rr('audit', '--run-dir', s.run, '--prepare');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(!r.lines.some((l) => /no claims from either seat/.test(l)), r.out);
  await assert.rejects(fs.access(path.join(s.run, 'phase3', 'findings.json')), 'no empty findings.json is written');
  assert.match(r.lines.at(-1), /--finish/);
});

test('a wait rerun after the exchange or the audit finished runs nothing and points to the next step', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait')).code, 0);
  // An empty exchange-result.json (an interrupted write) is not a finished exchange: phase2 --wait runs finish again.
  await fs.writeFile(path.join(s.run, 'phase2', 'exchange-result.json'), '');
  let before = (await s.calls()).length;
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait')).code, 0);
  assert.ok((await s.calls()).slice(before).some((c) => c.argv[0] === 'finish'), 'an empty record is not taken as done');
  await fs.writeFile(path.join(s.run, 'phase2', 'exchange-result.json'), '{"appended":["A","B"]}\n');
  before = (await s.calls()).length;
  for (const phase of ['phase2', 'phase1']) {
    const r = await s.rr(phase, '--run-dir', s.run, '--wait');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.lines.at(-1), /^next: run: review-run audit .*--prepare$/, `${phase} after the exchange`);
  }
  // An older record with conceded HIGH claims gets the same next line: every audit is full.
  await fs.writeFile(path.join(s.run, 'phase2', 'exchange-result.json'), '{"concede":8,"dispute":0,"high_conceded":2}\n');
  for (const phase of ['phase2', 'phase1']) {
    const r = await s.rr(phase, '--run-dir', s.run, '--wait');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.lines.at(-1), /^next: run: review-run audit .*--prepare$/, `${phase} with an older record`);
  }
  assert.deepEqual(await s.calls().then((c) => c.slice(before)), [], 'neither the seats, validate nor exchange finish run again');
  await fs.mkdir(path.join(s.run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase3', 'findings.json'), '{"findings":[]}\n');
  before = (await s.calls()).length;
  for (const phase of ['phase1', 'phase2']) {
    const r = await s.rr(phase, '--run-dir', s.run, '--wait');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.lines.at(-1), /^next: run: review-run manifest --run-dir .* then review-run report --run-dir /);
  }
  assert.deepEqual((await s.calls()).slice(before), []);
});

test('a CLI seat whose result.json exists but cannot be parsed yet is waited for, not dispatched a second time', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'B', 'result.json'), '{"status":');
  await s.ctl({ codexWait: 3 });
  const before = (await s.calls()).length;
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(names((await s.calls()).slice(before)).includes('codex-dispatch:start'), false, 'no second dispatch');
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

test('zero-claim finish: an empty findings.json from an interrupted write is written again, and a changed target is refused', async (t) => {
  const { computeSnapshotHash } = await import('../preflight.mjs');
  const s = await setup(t);
  s.desc.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(s.target) };
  await fs.rm(path.join(s.run, 'run.json'));
  await writeRunDescriptor(s.run, s.desc);
  await s.ctl({ zeroClaims: true });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  const file = path.join(s.run, 'phase3', 'findings.json');
  await fs.writeFile(file, '');
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).zero_claims, true, 'the empty file was replaced');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).audit_depth, 'full', 'the record names the one depth');
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--audit-depth', 'full')).code, 2, 'there is no depth to choose');
  await fs.rm(file);
  await fs.writeFile(path.join(s.target, 'file.txt'), 'changed after the seats reviewed it\n');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(r.code, 1, r.out);
  assert.match(r.lines.at(-2), /^FAILED fingerprint: /);
  await assert.rejects(fs.access(file), 'no zero-claim record for a changed target');
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

test('field northwind-1a: phase1 --wait stops on drift with a next: line naming --accept-drift; with it the run goes on and records step phase1; phase1 --start never accepts it', async (t) => {
  const { computeSnapshotHash, fingerprintFiles } = await import('../preflight.mjs');
  const s = await setup(t);
  const file = path.join(s.run, 'run.json');
  const desc = JSON.parse(await fs.readFile(file, 'utf8'));
  desc.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(s.target) };
  await fs.writeFile(file, JSON.stringify(desc));
  await fs.writeFile(path.join(s.run, 'fingerprint-files.json'), JSON.stringify(await fingerprintFiles(s.target)));
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.target, 'file.txt'), 'changed by another session\n');
  const refused = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.lines.at(-2), /^FAILED fingerprint: .*changed: file\.txt/);
  assert.match(refused.lines.at(-1), /rerun this command with --accept-drift/);
  const accepted = await s.rr('phase1', '--run-dir', s.run, '--wait', '--accept-drift');
  assert.equal(accepted.code, 0, accepted.out);
  assert.ok(accepted.lines.some((l) => /accepted with --accept-drift.*a seat still working may have read the changed files/.test(l)), accepted.out);
  const record = JSON.parse(await fs.readFile(path.join(s.run, 'phase3', 'drift-accepted.json'), 'utf8'));
  assert.deepEqual(record.accepted.map((a) => [a.step, a.files]), [['phase1', ['file.txt']]]);
  const s2 = await setup(t);
  const file2 = path.join(s2.run, 'run.json');
  const desc2 = JSON.parse(await fs.readFile(file2, 'utf8'));
  desc2.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: 'not-the-current-hash' };
  await fs.writeFile(file2, JSON.stringify(desc2));
  assert.equal((await s2.rr('phase1', '--run-dir', s2.run, '--start', '--accept-drift')).code, 1, 'nothing paid has run yet, so --start stays strict');
});

test('audit --finish names the files that drifted after Phase 1, and --accept-drift goes on and records them for the manifest', async (t) => {
  const { computeSnapshotHash, fingerprintFiles } = await import('../preflight.mjs');
  const { initBody } = await import('../build-manifest.mjs');
  const s = await prepared(t, { auditor: { transport: 'native' } });
  s.desc.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(s.target) };
  await fs.rm(path.join(s.run, 'run.json'));
  await writeRunDescriptor(s.run, s.desc);
  await fs.writeFile(path.join(s.run, 'fingerprint-files.json'), JSON.stringify(await fingerprintFiles(s.target)));
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor')).code, 0);
  await fs.writeFile(path.join(s.target, 'file.txt'), 'changed by another session\n');
  await fs.writeFile(auditOut(s), '{"native":true}\n');
  const refused = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.lines.at(-2), /^FAILED fingerprint: .*changed: file\.txt/);
  assert.match(refused.lines.at(-1), /--accept-drift/);
  const accepted = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor', '--accept-drift');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(accepted.lines.filter((l) => /warning: the target changed after Phase 1 \(changed: file\.txt\); accepted with --accept-drift.*the auditor reads the current target/.test(l)).length, 1, accepted.out);
  assert.match(refused.lines.at(-1), /rerun: review-run audit --run-dir .* --finish --accept-drift \(the manifest/);
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), true);
  const record = JSON.parse(await fs.readFile(path.join(s.run, 'phase3', 'drift-accepted.json'), 'utf8'));
  assert.deepEqual(record.accepted.map((a) => a.files), [['file.txt']]);
  assert.deepEqual((await initBody(s.desc, s.run)).drift_accepted.map((a) => a.files), [['file.txt']]);
});

test('audit --finish --accept-drift with a CLI auditor prints the drift warning once, although the target is checked three times', async (t) => {
  const { computeSnapshotHash, fingerprintFiles } = await import('../preflight.mjs');
  const s = await prepared(t);
  s.desc.fingerprint = { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(s.target) };
  await fs.rm(path.join(s.run, 'run.json'));
  await writeRunDescriptor(s.run, s.desc);
  await fs.writeFile(path.join(s.run, 'fingerprint-files.json'), JSON.stringify(await fingerprintFiles(s.target)));
  await fs.writeFile(path.join(s.target, 'file.txt'), 'changed by another session\n');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--accept-drift');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.lines.filter((l) => l.startsWith('warning: the target changed after Phase 1')).length, 1, r.out);
});

test('a verifier file with Verdict REFUTED and Basis INFERENCE fails staging before the auditor runs; with cited lines it is staged [slow]', async (t) => {
  const stage = async (body) => {
    const s = await prepared(t, { flags: { falsification: true } });
    await fs.writeFile(path.join(s.run, 'phase3', 'verification-Y1.md'), body);
    return { s, r: await s.rr('audit', '--run-dir', s.run, '--finish') };
  };
  const inferred = await stage('Claim: Y1\nVerdict: REFUTED\nBasis: INFERENCE\nEvidence: it looks fine\n');
  assert.equal(inferred.r.code, 1, inferred.r.out);
  assert.match(inferred.r.lines.at(-2), /^FAILED stage verification: verification-Y1\.md says Verdict REFUTED with Basis INFERENCE/);
  await assert.rejects(fs.access(path.join(`${inferred.s.run}-audit-input`, 'verification-Y1.md')), 'the file is not staged');
  // A fenced example is not the verdict, above the real lines or in the evidence.
  const cited = await stage('```\nVerdict: REFUTED\nBasis: INFERENCE\n```\nClaim: Y1\nVerdict: REFUTED\nBasis: STATIC_TRACE\nEvidence: a.js:3 returns early\n```\nBasis: INFERENCE\n```\n');
  assert.equal(cited.r.code, 0, cited.r.out);
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
    return relabelStep(argv).then((r) => ({ status: r.code, stdout: r.stdout, stderr: r.stderr }));
  };
}

async function finishWithRealScan(s, io = {}) {
  let out = '';
  let err = '';
  const code = await runInProcess(['audit', '--run-dir', s.run, '--finish'], {
    stdout: { write: (c) => { out += c; } }, stderr: { write: (c) => { err += c; } }, steps: realScanRunner(s.hook), skill: s.state.runAs, ...io,
  });
  return { code, out, err, lines: out.trim().split('\n') };
}

async function stageRealScanRun(t, evidence, options = {}) {
  const s = await prepared(t, { flags: { falsification: true }, ...options });
  await fs.mkdir(path.join(s.run, 'phase1'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim a\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  await fs.writeFile(path.join(s.run, 'phase1', 'B-findings.md'), '## B1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim b\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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

test('Linux round linux-r4 B4: a verification file that names the run folder is stopped and never staged', async (t) => {
  const s = await stageRealScanRun(t, 'Evidence: the code at file.txt line 1 shows the defect.');
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), `Verdict: confirmed.\n\nEvidence: compared with ${path.join(s.run, 'phase1')}.\n`);
  const r = await finishWithRealScan(s);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.lines.at(-2), /^FAILED stage verification: verification-X1\.md names the run folder/);
  await assert.rejects(fs.access(path.join(`${s.run}-audit-input`, 'verification-X1.md')), 'not copied to the auditor folder');
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
  assert.match(doc.replace(/\s+/g, ' '), /dispatches that seat again as a new session in the same worktree[^.]*it does not resume the failed session/);
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

test('seats are started without a time limit: --timeout 0 for Claude and Codex seats, and flags.timeoutS when the user set one', async (t) => {
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

test('restructure round 3 F6: a deep verify after a finished native audit is scanned and staged for the resumed auditor', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0);
  await fs.mkdir(`${s.run}-audit-input`, { recursive: true });
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"done":true}\n');
  const done = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(done.code, 0, done.out);
  assert.ok(await fs.access(path.join(s.run, 'phase3', 'findings.json')).then(() => true, () => false), 'the audit finished');
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified after the audit\n');
  // Linux round linux-r7 A3, Windows round win-r7 A4: the file is staged first and the step stops, so the auditor is resumed
  // with it in its folder; the next --finish translates the auditor's new answer.
  const again = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(again.code, 3, again.out);
  assert.match(again.out, /verification-X1\.md staged for the auditor: resume the same auditor/);
  assert.equal(await fs.readFile(path.join(`${s.run}-audit-input`, 'verification-X1.md'), 'utf8'), 'verified after the audit\n');
  assert.ok((await s.calls()).some((c) => c.script === 'blind-relabel.mjs' && c.argv[0] === 'scan' && s.flag(c, '--in').endsWith('verification-X1.md')), 'the file was scanned');
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"done":true,"verified":true}\n');
  const done2 = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(done2.code, 0, done2.out);
  assert.doesNotMatch(done2.out, /staged for the auditor/, 'a file staged before counts once');
});

test('Linux round linux-r5 B3, Windows round win-r6 A3: a verification file that arrives after the auditor brief, before the audit finished, stops the step naming it', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0, 'the brief is built; the native auditor has not answered');
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified late\n');
  const again = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /FAILED stage verification: verification-X1\.md arrived after the auditor brief was built, so the auditor cannot cite it/);
  await assert.rejects(fs.access(path.join(`${s.run}-audit-input`, 'verification-X1.md')), 'not staged');
});

test('Linux round linux-r7 B2: a verification file changed after it was staged stops audit --finish before translate', async (t) => {
  const s = await prepared(t, { auditor: { transport: 'native' } });
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'original evidence\n');
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--finish')).code, 0, 'staged with the brief');
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'replacement evidence\n');
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"done":true}\n');
  const r = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAILED stage verification: verification-X1\.md changed after it was staged for the auditor/);
  assert.equal((await s.calls()).some((c) => c.argv[0] === 'translate'), false, 'nothing translated');
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

test('Linux round linux-r6 A1: after --accept-missing-verifiers, the rerun its next: line names (no flag) finishes a native audit', async (t) => {
  const s = await setup(t, { flags: { falsification: true }, auditor: { transport: 'native' } });
  await s.ctl({ qualified: 2 });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const accepted = await s.rr('audit', '--run-dir', s.run, '--finish', '--accept-missing-verifiers');
  assert.equal(accepted.code, 0, accepted.out);
  await fs.writeFile(path.join(`${s.run}-audit-input`, 'findings.audit.json'), '{"done":true}\n');
  const again = await s.rr('audit', '--run-dir', s.run, '--finish', '--native-done', 'auditor');
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /FAILED verifiers/);
});

test('audit with no claims from either seat: no auditor brief, an empty findings.json, and next points at the manifest and report', async (t) => {
  const s = await setup(t);
  await s.ctl({ zeroClaims: true });
  const prep = await s.rr('audit', '--run-dir', s.run, '--prepare');
  assert.equal(prep.code, 0, prep.out + prep.err);
  assert.ok(prep.lines.some((l) => /no claims from either seat: the auditor and the scorecard are not needed/.test(l)), prep.out);
  assert.match(prep.lines.at(-1), /^next: run: review-run manifest --run-dir .*, then review-run report --run-dir /);
  const file = path.join(s.run, 'phase3', 'findings.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { audit_depth: 'full', zero_claims: true, findings: [] });
  const finish = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(finish.code, 0, finish.out);
  assert.match(finish.lines.at(-1), /^next: run: review-run manifest --run-dir /);
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'rate-limited', retryAfter: clock, finishedAt: new Date().toISOString(), touchedFiles: [] }));
  const before = (await s.calls()).length;
  const waiting = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(waiting.code, 3, waiting.out);
  assert.match(waiting.lines.at(-1), new RegExp(`seat A hit a usage limit until ${clock}`));
  assert.equal((await s.calls()).slice(before).some((c) => c.argv.includes('--detach')), false, 'no new session while limited');
  const past = new Date(Date.now() - 60000);
  const pastClock = `${((past.getHours() + 11) % 12) + 1}:${String(past.getMinutes()).padStart(2, '0')} ${past.getHours() >= 12 ? 'PM' : 'AM'}`;
  await fs.writeFile(path.join(s.run, 'phase1', 'A', 'result.json'), JSON.stringify({ status: 'rate-limited', retryAfter: pastClock, finishedAt: new Date(Date.now() - 90000).toISOString(), touchedFiles: [] }));
  const retry = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(retry.code, 0, retry.out);
  assert.ok(retry.lines.some((l) => /previous attempt ended with status rate-limited; dispatched again/.test(l)), 'after the time, the usual retry runs');
  const a = await auditorWithBrief(t, { status: 'rate-limited', retryAfter: clock, finishedAt: new Date().toISOString(), touchedFiles: [] }, { output: false });
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
  for (const role of ['A', 'B']) await fs.writeFile(path.join(s.run, 'phase1', role + '-findings.md'), `## ${role}1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n`);
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const transcript = path.join(s.base, 'agent-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'tool_use' })].join('\n') + '\n');
  const working = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', `A=${transcript}`);
  assert.equal(working.code, 3, working.out);
  assert.match(working.lines.at(-1), /seat A's agent is still working \(its transcript has no final reply yet\)/);
  assert.match(working.lines.at(-1), /review-run phase1 --run-dir .* --wait; do not start phase2 until this exits 0$/);
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const transcript = path.join(s.base, 'agent-transcript.jsonl');
  await fs.writeFile(transcript, [turn('user'), turn('assistant', { stop: 'end_turn' })].join('\n') + '\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', `A=${transcript}`)).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase2', 'A-rebuttals-raw.md'), '## Rebuttals (from A) of B claims\n\n### P1\nCONCEDE\n');
  await fs.appendFile(transcript, turn('user') + '\n');
  const again = await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1');
  assert.equal(again.code, 3, again.out);
  assert.match(again.lines.at(-1), /--wait; do not run audit --prepare until this exits 0$/);
  await fs.appendFile(transcript, turn('assistant', { stop: 'end_turn' }) + '\n');
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--wait', '--max-wait', '1')).code, 0);
  const missing = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await missing.rr('phase1', '--run-dir', missing.run, '--start')).code, 0);
  await fs.writeFile(path.join(missing.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'no-agents '));
  t.after(() => fs.rm(config, { recursive: true, force: true }));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  const none = await missing.rr('phase1', '--run-dir', missing.run, '--wait', '--max-wait', '1', '--native-agent', 'A=a0123456789abcdef');
  assert.equal(none.code, 1, none.out);
  assert.match(none.lines.at(-2), /^FAILED native agent A: no agent with id a0123456789abcdef under this host's Claude or Codex transcripts: check the id the Agent tool returned/);
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
  await fs.writeFile(path.join(s.run, 'phase1', 'B-findings.md'), '## B1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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
  // Round 4 F3: the brief's own scratch folder is the one exception, for reading and for editing.
  assert.match(text, /Do not read any other file in the run folder except the brief, the task packet it names, your own findings file and your own scratch folder\. Do not edit any file except your own findings file and the files you create in your own scratch folder\./);
  assert.match(text, /reply with only the word written/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--native-done', 'A')).code, 0);
  const exchange = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(exchange.out.includes('prompt to send it: ' + path.join(s.run, 'phase2', 'prompt-A.txt')), exchange.out);
  assert.match(await fs.readFile(path.join(s.run, 'phase2', 'prompt-A.txt'), 'utf8'), /Phase 2\. Read your delta brief from .*delta-brief-A\.txt/);
  // Closing round 4 F10: the resume message allows what the delta brief allows (Phase 1 brief, task packet, scratch folder).
  assert.match(await fs.readFile(path.join(s.run, 'phase2', 'prompt-A.txt'), 'utf8'), /except the delta brief, your Phase 1 brief, the task packet, your rebuttal file and your own scratch folder\. Do not edit any file except your rebuttal file and the files you create in your own scratch folder\./);
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  // Seat A was resumed and finished this time (a file next to a "blocked:" reply would be an unfinished pass).
  await fs.appendFile(claude, [turn('user'), reply('written, 1 claim')].join('\n') + '\n');
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const late = await pending;
  assert.equal(late.code, 0, late.out);
  assert.ok(late.lines.includes('seat A: output found (native, transcript shows the agent finished)'), late.out);
});

test('--native-agent: a working agent with no file yet is "still working", never "spawn it"', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const transcript = path.join(s.base, 'working-agent.jsonl');
  await fs.writeFile(transcript, `${turn('user')}\n`);
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', 'A=' + transcript);
  assert.equal(r.code, 3, r.out);
  assert.match(r.lines.at(-1), /seat A: its agent is still working and has not written .*A-findings\.md yet; rerun this command/);
  assert.doesNotMatch(r.lines.at(-1), /spawn it/);
});

test('--native-agent: an agent whose transcript shows it finished, with no file yet, is not called "still working"', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const transcript = path.join(s.base, 'ended-agent.jsonl');
  await fs.writeFile(transcript, [turn('user'), reply('blocked: shell tool timed out')].join('\n') + '\n');
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-agent', 'A=' + transcript);
  assert.equal(r.code, 3, r.out);
  assert.match(r.lines.at(-1), /seat A: its agent's transcript shows it finished, but .*A-findings\.md is not there yet; rerun this command with --max-wait \d+ or more/);
  assert.doesNotMatch(r.lines.at(-1), /still working/);
});

test('Linux round F4: phase1 --start warns about a path the packet names that does not exist', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  const gone = path.join(s.base, 'evidence gone', 'capture.log');
  // A path with spaces is written in backticks (a bare path ends at the first space).
  await fs.appendFile(path.join(s.run, 'task-packet.md'), `\nEvidence: \`${gone}\`\n`);
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 0, r.out);
  assert.ok(r.lines.some((l) => l.startsWith('warning: the packet names 1 path(s) that do not exist here') && l.includes(gone)), r.out);
});

test('Linux round linux-r1 O1: phase2 --start moves a seat\'s leftover Phase 1 scratch folder out of the run folder before the exchange', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const seatDir = (await fs.stat(path.join(s.run, 'phase1', 'seat-A')).catch(() => null)) ? path.join(s.run, 'phase1', 'seat-A') : path.join(s.run, 'phase1');
  const scratch = path.join(seatDir, 'scratch-0a1b2c3d');
  await fs.mkdir(path.join(scratch, 'g', 'run', 'phase1'), { recursive: true });
  await fs.writeFile(path.join(scratch, 'g', 'run', 'phase1', 'B-findings.md'), 'a mock peer file from a test\n');
  if (process.platform !== 'win32') await fs.symlink(path.join(scratch, 'g', 'run'), path.join(scratch, 'g', 'link'));
  const other = path.join(seatDir, 'notes');
  await fs.mkdir(other);
  const r = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.equal(r.code, 0, r.out);
  const kept = path.join(`${s.run}-scratch-kept`, 'scratch-0a1b2c3d');
  t.after(() => fs.rm(`${s.run}-scratch-kept`, { recursive: true, force: true }));
  assert.ok(r.lines.some((l) => l.includes(`${seatDir.endsWith('seat-A') ? "seat A's" : "a seat's"} scratch folder scratch-0a1b2c3d was moved out of the run folder to`) && l.includes(kept)), r.out);
  assert.equal(await fs.readFile(path.join(kept, 'g', 'run', 'phase1', 'B-findings.md'), 'utf8'), 'a mock peer file from a test\n', 'kept, not deleted');
  await assert.rejects(fs.access(scratch), { code: 'ENOENT' });
  assert.ok((await fs.stat(other)).isDirectory(), 'only scratch-<hash> folders are moved');
});

test('field feedback S2: phase1 --start repeats the tools preflight found the Codex seat cannot start', async (t) => {
  const s = await setup(t);
  await fs.writeFile(path.join(s.run, 'seat-tools.json'), JSON.stringify({ python: { ok: false, why: 'x', host: null }, rg: { ok: false, why: 'y', host: null }, git: { ok: true } }));
  const r = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.equal(r.code, 0, r.out);
  assert.ok(r.lines.some((l) => l === "warning: preflight found that the Codex seat's sandbox cannot run python, rg (seat-tools.json); it reviews those parts by reading only"), r.out);
});

test('field feedback S7: cleanup lists the seats\' scratch folders, deletes them only with --yes, and never follows a link out', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const seatDir = (await fs.stat(path.join(s.run, 'phase1', 'seat-A')).catch(() => null)) ? path.join(s.run, 'phase1', 'seat-A') : path.join(s.run, 'phase1');
  const scratch = path.join(seatDir, 'scratch-0a1b2c3d');
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(scratch, 'big.bin'), Buffer.alloc(2 * 1048576));
  const outside = path.join(path.dirname(s.run), 'outside-cleanup');
  await fs.mkdir(outside, { recursive: true });
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep\n');
  if (process.platform !== 'win32') await fs.symlink(outside, path.join(scratch, 'link'));
  const kept = path.join(`${s.run}-scratch-kept`, 'scratch-99887766-2');
  t.after(() => fs.rm(`${s.run}-scratch-kept`, { recursive: true, force: true }));
  await fs.mkdir(kept, { recursive: true });
  await fs.mkdir(path.join(seatDir, 'notes'), { recursive: true });
  const dry = await s.rr('cleanup', '--run-dir', s.run);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would delete .*scratch-0a1b2c3d \(2\.0 MB\)/);
  assert.match(dry.out, /2 scratch folder\(s\), 2\.0 MB\s+next: rerun with --yes/);
  assert.ok((await fs.stat(scratch)).isDirectory(), 'nothing deleted without --yes');
  const done = await s.rr('cleanup', '--run-dir', s.run, '--yes');
  assert.equal(done.code, 0, done.out);
  await assert.rejects(fs.access(scratch), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${s.run}-scratch-kept`), { code: 'ENOENT' }, 'the emptied kept folder is removed too');
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n', 'a link out of the scratch folder is not followed');
  assert.ok((await fs.stat(path.join(seatDir, 'notes'))).isDirectory(), 'only scratch-<hash> folders are deleted');
  // Windows round win-r3 A4: a folder in use is named, the others are still deleted, and the command fails with next:.
  const busyDir = path.join(seatDir, 'scratch-55667788');
  const freeDir = path.join(seatDir, 'scratch-99aabbcc');
  await fs.mkdir(busyDir, { recursive: true });
  await fs.mkdir(freeDir, { recursive: true });
  const realRm = fs.rm;
  fs.rm = async (p, o) => (path.resolve(p) === path.resolve(busyDir) ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : realRm(p, o));
  let inUse;
  try {
    inUse = await s.rr('cleanup', '--run-dir', s.run, '--yes');
  } finally {
    fs.rm = realRm;
  }
  assert.equal(inUse.code, 1, inUse.out);
  assert.match(inUse.out, /could not delete .*scratch-55667788: EBUSY/);
  assert.match(inUse.out, /deleted .*scratch-99aabbcc/);
  assert.match(inUse.out, /1 of 2 scratch folder\(s\) deleted/);
  assert.match(inUse.out, /FAILED cleanup: 1 scratch folder\(s\) could not be deleted/);
  await fs.rm(busyDir, { recursive: true, force: true });
  // Windows round win-r3 B3: a folder that cannot be listed stops the command; it never reports "no scratch".
  const realReaddir = fs.readdir;
  fs.readdir = async (p, o) => (path.resolve(p) === path.resolve(seatDir) ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : realReaddir(p, o));
  let denied;
  try {
    denied = await s.rr('cleanup', '--run-dir', s.run);
  } finally {
    fs.readdir = realReaddir;
  }
  assert.equal(denied.code, 1, denied.out);
  assert.match(denied.out, /FAILED cleanup: cannot list .*: EACCES/);
  assert.doesNotMatch(denied.out, /no seat scratch folder/);
  // Windows round win-r4 B2: a folder whose real path cannot be read is not "missing" either.
  const realRealpath = fs.realpath;
  fs.realpath = async (p, o) => (path.resolve(p) === path.resolve(seatDir) ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : realRealpath(p, o));
  let unreadable;
  try {
    unreadable = await s.rr('cleanup', '--run-dir', s.run);
  } finally {
    fs.realpath = realRealpath;
  }
  assert.equal(unreadable.code, 1, unreadable.out);
  assert.match(unreadable.out, /FAILED cleanup: cannot read .*: EACCES/);
  // A seat whose worker is still alive: nothing is listed or deleted.
  const record = path.join(s.run, 'phase2', 'A', 'result.json');
  await fs.mkdir(path.dirname(record), { recursive: true });
  await fs.writeFile(record, JSON.stringify({ status: 'running', startedAt: new Date().toISOString(), workerPid: process.pid, workerStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() }));
  const busy = await s.rr('cleanup', '--run-dir', s.run, '--yes');
  assert.equal(busy.code, 1, busy.out);
  assert.match(busy.out, /FAILED cleanup: seat A \(phase2\) is still running/);
});

test('Linux round linux-r3 A5: an unreadable source folder at the Phase 1 format check stops the step with FAILED and next:, not a stack trace', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const file = path.join(s.run, 'run.json');
  const desc = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...desc, sourceDirs: [path.join(path.dirname(s.run), 'gone-src')] }, null, 2));
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAILED seat format: .*gone-src/);
});

// A folder link: a junction on Windows (no elevation needed), a symlink elsewhere.
const linkDir = (target, at) => fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');

test('Linux round linux-r3 F4 (Windows round win-r4 A4: also a junction): cleanup never searches a folder that is a link, so a scratch-<hash> folder in its target stays', async (t) => {
  const s = await setup(t);
  const elsewhere = path.join(path.dirname(s.run), 'someone-else');
  await fs.mkdir(path.join(elsewhere, 'scratch-aabbccdd'), { recursive: true });
  await fs.writeFile(path.join(elsewhere, 'scratch-aabbccdd', 'precious.txt'), 'keep\n');
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await linkDir(elsewhere, `${s.run}-scratch-kept`);
  t.after(() => fs.unlink(`${s.run}-scratch-kept`).catch(() => {}));
  await fs.mkdir(path.join(elsewhere, 'p1', 'scratch-11223344'), { recursive: true });
  // Linux round linux-r4 B1: a seat folder inside the linked phase folder is behind the link too.
  await fs.mkdir(path.join(elsewhere, 'p1', 'seat-A', 'scratch-55554444'), { recursive: true });
  await fs.rm(path.join(s.run, 'phase1'), { recursive: true, force: true });
  await linkDir(path.join(elsewhere, 'p1'), path.join(s.run, 'phase1'));
  t.after(() => fs.unlink(path.join(s.run, 'phase1')).catch(() => {}));
  const r = await s.rr('cleanup', '--run-dir', s.run, '--yes');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skipped .*-scratch-kept: it is a link/);
  assert.match(r.out, /skipped .*phase1: it is a link/);
  assert.equal(await fs.readFile(path.join(elsewhere, 'scratch-aabbccdd', 'precious.txt'), 'utf8'), 'keep\n');
  assert.ok((await fs.stat(path.join(elsewhere, 'p1', 'scratch-11223344'))).isDirectory(), 'a scratch folder behind a linked phase folder stays');
  assert.ok((await fs.stat(path.join(elsewhere, 'p1', 'seat-A', 'scratch-55554444'))).isDirectory(), 'linux-r4 B1: a seat folder behind the link stays');
  assert.match(r.out, /skipped .*seat-A: it is a link or lies behind one/);
});

test('Linux round linux-r4 A1: phase2 --start moves nothing out of a linked seat folder', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const seatDir = path.join(s.run, 'phase1', 'seat-A');
  const elsewhere = path.join(path.dirname(s.run), 'other-seat-folder');
  await fs.mkdir(path.join(elsewhere, 'scratch-deadbeef'), { recursive: true });
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  for (const entry of await fs.readdir(seatDir)) await fs.cp(path.join(seatDir, entry), path.join(elsewhere, entry), { recursive: true });
  await fs.rm(seatDir, { recursive: true, force: true });
  await linkDir(elsewhere, seatDir);
  t.after(() => fs.unlink(seatDir).catch(() => {}));
  t.after(() => fs.rm(`${s.run}-scratch-kept`, { recursive: true, force: true }));
  const r = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(r.lines.some((l) => /seat-A is a link or lies behind one; nothing under it was moved/.test(l)), r.out);
  assert.ok((await fs.stat(path.join(elsewhere, 'scratch-deadbeef'))).isDirectory(), 'the link target\'s scratch folder stays where it is');
});

test('Linux round linux-r6 A4: a dangling <run-dir>-scratch-kept link is a link, not a missing folder', { skip: process.platform === 'win32' }, async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  await fs.mkdir(path.join(s.run, 'phase1', 'seat-A', 'scratch-0a1b2c3d'), { recursive: true });
  await fs.symlink(path.join(path.dirname(s.run), 'gone-folder'), `${s.run}-scratch-kept`);
  t.after(() => fs.unlink(`${s.run}-scratch-kept`).catch(() => {}));
  const r = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(r.lines.some((l) => /-scratch-kept is a link or lies behind one; no scratch folder was moved there/.test(l)), r.out);
});

test('Windows round win-r5 B2: phase2 --start moves nothing into a linked <run-dir>-scratch-kept', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  const scratch = path.join(s.run, 'phase1', 'seat-A', 'scratch-0a1b2c3d');
  await fs.mkdir(scratch, { recursive: true });
  const elsewhere = path.join(path.dirname(s.run), 'someone-elses-folder');
  await fs.mkdir(elsewhere, { recursive: true });
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await linkDir(elsewhere, `${s.run}-scratch-kept`);
  t.after(() => fs.unlink(`${s.run}-scratch-kept`).catch(() => {}));
  const r = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(r.lines.some((l) => /-scratch-kept is a link or lies behind one; no scratch folder was moved there/.test(l)), r.out);
  assert.deepEqual(await fs.readdir(elsewhere), [], 'nothing was moved into the link target');
  assert.ok((await fs.stat(scratch)).isDirectory(), 'the scratch folder stays');
});

test('Linux round linux-r1 F4: --incomplete-seat stops the seat worker that has not started its CLI yet', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const { processStartMs, processStartToken, processExists } = await import('../detach-utils.mjs');
  const { spawn } = await import('node:child_process');
  // A detached worker leads its own process group on POSIX.
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  t.after(() => { try { worker.kill(); } catch { /* already gone */ } });
  await new Promise((r) => worker.once('spawn', r));
  // Linux round linux-r3 A3: what the worker's log says its CLI left is named too.
  const workerLog = path.join(s.run, 'phase2', 'A', 'dispatch-worker.log');
  await fs.writeFile(workerLog, "relay: WARNING: codex left 1 process(es) running in its tool commands' process groups (pid 4242); they were stopped\n");
  await fs.writeFile(path.join(s.run, 'phase2', 'A', 'result.json'), JSON.stringify({ status: 'running', sessionId: 'sess-A', workerPid: worker.pid, workerStartedAt: new Date(processStartMs(worker.pid) ?? Date.now()).toISOString(), workerStartToken: processStartToken(worker.pid), startedAt: new Date().toISOString(), workerLog }));
  const wait = await s.rr('phase2', '--run-dir', s.run, '--wait', '--incomplete-seat', 'A');
  assert.equal(wait.code, 0, wait.out + wait.err);
  assert.ok(wait.lines.some((l) => /seat A: its Phase 2 worker was still running and was stopped/.test(l)), wait.out);
  assert.ok(wait.lines.some((l) => l === "warning: seat A: codex left 1 process(es) running in its tool commands' process groups (pid 4242); they were stopped"), wait.out);
  for (let i = 0; i < 50 && processExists(worker.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(processExists(worker.pid), false, 'the worker is gone');
});

test('Linux round linux-r1 F5: phase1 --start names only the outside paths a reach probe of this run did not read', { skip: !['linux', 'win32'].includes(process.platform) }, async (t) => {
  const run = async (probed) => {
    const s = await setup(t, { seatA: { transport: 'native' } });
    const evidence = path.join(s.base, 'evidence');
    await fs.mkdir(evidence, { recursive: true });
    const [read, unread] = [path.join(evidence, 'read.log'), path.join(evidence, 'unread.log')];
    for (const f of [read, unread]) await fs.writeFile(f, 'x\n');
    await fs.appendFile(path.join(s.run, 'task-packet.md'), `\nEvidence: \`${read}\` and \`${unread}\`\n`);
    if (probed) await fs.writeFile(path.join(s.run, 'reach-probe.json'), JSON.stringify({ ran: true, results: [{ item: `READ ${read}`, ok: true }, { item: `READ ${unread}`, ok: false, detail: 'Permission denied' }] }));
    const r = await s.rr('phase1', '--run-dir', s.run, '--start');
    assert.equal(r.code, 0, r.out);
    return { warning: r.lines.find((l) => /outside the target/.test(l)) ?? '', read, unread };
  };
  const plain = await run(false);
  assert.match(plain.warning, /names 2 path\(s\) outside the target/);
  const probed = await run(true);
  assert.match(probed.warning, /names 1 path\(s\) outside the target .*\(no reach probe of this run read them\)/);
  assert.ok(probed.warning.includes(probed.unread) && !probed.warning.includes(probed.read), probed.warning);
});

test('Linux round F2: phase1 --wait warns when one seat is far shallower than its peer; seats of similar depth pass quietly', async (t) => {
  const d = (claims, web) => ({ claims, web });
  assert.match(shallowSeatNote([d(15, 11), d(1, 0)]), /^seat B did far less than seat A \(1 claim\(s\) against seat A's 15; web use 0 against 11\)/);
  assert.equal(shallowSeatNote([d(2, null), d(4, null)]), null);
  assert.equal(shallowSeatNote([d(3, 2), d(3, 3)]), null, 'similar seats: no note');
  // Linux round 2 F4: claims and web use are separate signals; either gap alone warns.
  assert.match(shallowSeatNote([d(1, 10), d(10, 10)]), /^seat A did far less than seat B \(1 claim\(s\) against seat B's 10\)/);
  assert.match(shallowSeatNote([d(0, 0), d(0, 20)]), /^seat A did far less than seat B \(web use 0 against 20\)/);
  assert.deepEqual(seatDepth('# Seat A findings\n\n## A1 — x\n```\nSame shape elsewhere: none found\n## A9 in a fence\n```\nSame shape elsewhere: none found\n## A2 — y\nSame shape elsewhere: none found\n## Checks performed\nweb: 3 queries, 8 page fetches\n', 'A'), { claims: 2, web: 11 });
  const s = await setup(t, { host: 'descriptor-host-name', seatA: { transport: 'native' }, seatB: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-luna', transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), ['# Seat A findings', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `\n## A${n} — claim ${n}\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nx\nSame shape elsewhere: none found`), '\n## Checks performed\nBlocked: none\n'].join('\n'));
  await fs.writeFile(path.join(s.run, 'phase1', 'B-findings.md'), '# Seat B findings\n\n## B1 — one\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nx\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '2', '--native-done', 'A,B');
  assert.equal(r.code, 0, r.out);
  assert.ok(r.lines.some((l) => l.startsWith("warning: seat B did far less than seat A (1 claim(s) against seat A's 8")), r.out);
});

const handback = (message) => JSON.stringify({ type: 'assistant', message: { id: String(Math.random()), stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] } });

test('Mac round 4 F7: a finished agent whose file has a claim but whose last reply (text or hand-back) is "blocked:" fails the wait; a reply that is not "written" warns', async (t) => {
  for (const [label, last] of [['hand-back', handback('blocked: the Write tool failed with EACCES after the first finding')], ['text', reply('blocked: shell tool timed out')]]) {
    const s = await setup(t, { seatA: { transport: 'native' } });
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 — one\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
    const transcript = path.join(s.base, 'blocked-agent.jsonl');
    await fs.writeFile(transcript, [turn('user'), last].join('\n') + '\n');
    const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '2', '--native-agent', 'A=' + transcript);
    assert.equal(r.code, 1, `${label}: ${r.out}`);
    assert.match(r.out, /its agent replied "blocked: .*", so .*A-findings\.md is from an unfinished pass/, label);
  }
  const ok = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await ok.rr('phase1', '--run-dir', ok.run, '--start')).code, 0);
  await fs.writeFile(path.join(ok.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 — one\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const odd = path.join(ok.base, 'odd-agent.jsonl');
  await fs.writeFile(odd, [turn('user'), handback('done, 1 claim')].join('\n') + '\n');
  const r = await ok.rr('phase1', '--run-dir', ok.run, '--wait', '--max-wait', '2', '--native-agent', 'A=' + odd);
  assert.match(r.out, /warning: seat A's agent finished with "done, 1 claim", not "written"/);
  assert.match(r.out, /seat A: output found \(native, transcript shows the agent finished\)/);
  // Closing round 2: a Codex agent whose last turn was aborted, after an earlier "written" turn, is refused.
  const cut = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await cut.rr('phase1', '--run-dir', cut.run, '--start')).code, 0);
  await fs.writeFile(path.join(cut.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 — one\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const rollout = path.join(cut.base, 'aborted-rollout.jsonl');
  const ev = (payload) => JSON.stringify({ type: 'event_msg', payload });
  await fs.writeFile(rollout, [JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }), ev({ type: 'task_started' }), ev({ type: 'task_complete', last_agent_message: 'written' }), ev({ type: 'task_started' }), ev({ type: 'turn_aborted' })].join('\n') + '\n');
  const a = await cut.rr('phase1', '--run-dir', cut.run, '--wait', '--max-wait', '2', '--native-agent', 'A=' + rollout);
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /its agent's last turn was aborted, so .*A-findings\.md may be partial; resume the same agent/);
  // Closing round 3: a later turn that completed with no reply is not silent.
  const quiet = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await quiet.rr('phase1', '--run-dir', quiet.run, '--start')).code, 0);
  await fs.writeFile(path.join(quiet.run, 'phase1', 'A-findings.md'), '# Seat A findings\n\n## A1 — one\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  const silent = path.join(quiet.base, 'silent-rollout.jsonl');
  await fs.writeFile(silent, [JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }), ev({ type: 'task_started' }), ev({ type: 'task_complete', last_agent_message: 'written' }), ev({ type: 'task_started' }), ev({ type: 'task_complete' })].join('\n') + '\n');
  const q = await quiet.rr('phase1', '--run-dir', quiet.run, '--wait', '--max-wait', '2', '--native-agent', 'A=' + silent);
  assert.match(q.out, /seat A's agent finished its last turn with no reply, not "written"/);
});

test('Mac round 4 F3: --native-done for a seat or the auditor whose file is missing or has no claim fails after the file grace, naming the file', async (t) => {
  process.env.REVIEW_FILE_GRACE_S = '1';
  t.after(() => { delete process.env.REVIEW_FILE_GRACE_S; });
  for (const content of [null, '# Seat A findings\n']) {
    const s = await setup(t, { seatA: { transport: 'native' } });
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    if (content !== null) await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), content);
    const started = Date.now();
    const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '30', '--native-done', 'A');
    assert.equal(r.code, 1, r.out);
    assert.ok(Date.now() - started < 20000, 'the file grace, not the 30 s budget');
    assert.match(r.out, new RegExp(`--native-done A says its agent finished, but .*A-findings\\.md ${content === null ? 'does not exist' : 'has no claim heading'}`));
  }
  const a = await prepared(t, { auditor: { transport: 'native' } });
  assert.equal((await a.rr('audit', '--run-dir', a.run, '--finish')).code, 0, 'the first --finish builds the brief and prints the spawn line');
  const r = await a.rr('audit', '--run-dir', a.run, '--finish', '--native-done', 'auditor');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--native-done auditor says its agent finished, but .*findings\.audit\.json does not exist/);
});

test('status: a run whose manifest.json is written is finished, not "next: review-run manifest"', async (t) => {
  const s = await setup(t);
  await fs.mkdir(path.join(s.run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase3', 'findings.json'), '{"findings":[]}\n');
  await fs.writeFile(path.join(s.run, 'manifest.json'), '{"status":"completed"}\n');
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: finished: manifest\.json is written/);
});

test('phase2 --wait: each exchange finish warning is shown, a long one cut', async (t) => {
  const s = await setup(t);
  await s.ctl({ finishWarning: `exchange: WARNING: first\nexchange: WARNING: ${'y'.repeat(300)}\nexchange: a note` });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase2', '--run-dir', s.run, '--wait');
  const shown = r.lines.filter((l) => l.includes('WARNING'));
  assert.deepEqual(shown.map((l) => l.length), ['exchange: WARNING: first'.length, 230], r.out);
  assert.ok(shown[1].endsWith('...'), r.out);
});

test('status: one line per run folder, from not started through phase 1 to a finished audit; it runs nothing', async (t) => {
  const a = await setup(t);
  const b = await setup(t);
  const missing = path.join(b.run, '..', 'no-such-run');
  const first = await a.rr('status', '--run-dir', a.run, '--run-dir', b.run, '--run-dir', missing);
  assert.equal(first.code, 0, first.out);
  assert.match(first.lines[0], /: not started; next: phase1 --start$/);
  // Linux round F11: the cause is kept, not cut off behind the repeated folder path.
  assert.match(first.lines[2], /: run\.json not readable \(cannot read run descriptor run\.json: ENOENT\)$/);
  assert.equal((await a.rr('phase1', '--run-dir', a.run, '--start')).code, 0);
  const before = (await a.calls()).length;
  const during = await a.rr('status', '--run-dir', a.run);
  assert.match(during.lines[0], /: phase1: seat A: .*; seat B: /);
  assert.equal((await a.calls()).length, before, 'status started nothing');
  // audit --prepare staged the auditor's folder: the next step is --finish, not --prepare again.
  await fs.mkdir(`${a.run}-audit-input`, { recursive: true });
  await fs.writeFile(path.join(`${a.run}-audit-input`, 'X-findings.md'), '## X1\n');
  assert.match((await a.rr('status', '--run-dir', a.run)).lines[0], /: audit prepared; next: audit --finish \(first brief \d{4}-[^)]+\)$/);
  await fs.mkdir(path.join(b.run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(b.run, 'phase3', 'findings.json'), '{"findings":[]}\n');
  assert.match((await b.rr('status', '--run-dir', b.run)).lines[0], /: audit finished; next: review-run manifest, then review-run report$/, 'no brief was written, so no first brief time');
  assert.equal((await a.rr('status')).code, 2, 'status needs a --run-dir');
});

test('next lines name --native-agent first, and phase2 --start says when the phase 1 agent id is remembered', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  const start1 = await s.rr('phase1', '--run-dir', s.run, '--start');
  assert.match(start1.lines.at(-1), /--wait --native-agent <seat>=<agent id> \(it waits on the agent itself; or --native-done <seat>/);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
  // Linux round F10: status tells a validated Phase 1 from one still running, and names the next step.
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: phase1 finished; next: run: review-run phase2 --run-dir .* --start \(first brief \d{4}-[^)]+\)$/);
  const without = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.match(without.lines.at(-1), /--wait --native-agent A=<agent id> \(or --native-done/);
  await fs.writeFile(path.join(s.run, 'native-agents.json'), JSON.stringify({ A: 'a0123456789abcdef' }));
  const again = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.match(again.lines.at(-1), /--wait \(the phase 1 agent id of seat A is remembered; no flag needed\)$/);
});

test('phase2 --start: next does not ask to resume a native seat that was skipped', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  await s.ctl({ skipped: { A: 'seat B has no findings' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A')).code, 0);
  const start = await s.rr('phase2', '--run-dir', s.run, '--start');
  assert.ok(start.lines.some((l) => l.startsWith('seat A: skipped')), start.out);
  assert.doesNotMatch(start.lines.at(-1), /resume each native seat/);
  assert.match(start.lines.at(-1), /^next: run: review-run phase2 /);
});

test('a CLI seat whose job object stopped what it left running is noted; a refused job object is a warning', async (t) => {
  const nl = String.fromCharCode(10);
  const finalB = ['# Seat B findings', '', '## B1 — one claim', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', '', '## Checks performed', '- AC-1: ok. MET', 'Blocked: none', ''].join(nl);
  for (const [recordB, pattern] of [
    [{ leftoversStopped: [4242, 4243] }, /seat B: its CLI left 2 process\(es\) running; they were stopped/],
    [{ jobRefused: 'AssignProcessToJobObject failed: 5' }, /warning: seat B could not run in a job object \(AssignProcessToJobObject failed: 5\); a process it started can outlive it/],
  ]) {
    const s = await setup(t);
    await s.ctl({ finalB, recordB });
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, pattern);
  }
});

test('closing round 2: a CLI seat stopped after its answer is noted, and one whose output stayed open is a warning carried to the manifest and report', async (t) => {
  const nl = String.fromCharCode(10);
  const finalB = ['# Seat B findings', '', '## B1 — one claim', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', '', '## Checks performed', '- AC-1: ok. MET', 'Blocked: none', ''].join(nl);
  const s = await setup(t);
  await s.ctl({ finalB, recordB: { stoppedAfterAnswer: true, stopIncomplete: true } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /seat B: ran on past its final answer; the answer was kept/);
  assert.match(r.out, /warning: seat B's output stayed open after its answer: a process it started may still be running/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.run, 'stop-incomplete.json'), 'utf8')), { 'seat B (phase1)': true });
  // The Phase 2 resume runs through the same dispatcher and is recorded too.
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const p2 = await s.rr('phase2', '--run-dir', s.run, '--wait');
  assert.equal(p2.code, 0, p2.out);
  assert.match(p2.out, /warning: seat B's output stayed open after its answer/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.run, 'stop-incomplete.json'), 'utf8')), { 'seat B (phase1)': true, 'seat B (phase2)': true });
  const quiet = await setup(t);
  await quiet.ctl({ finalB, recordB: { stoppedAfterAnswer: true } });
  assert.equal((await quiet.rr('phase1', '--run-dir', quiet.run, '--start')).code, 0);
  const q = await quiet.rr('phase1', '--run-dir', quiet.run, '--wait');
  assert.match(q.out, /seat B: ran on past its final answer/);
  assert.doesNotMatch(q.out, /output stayed open/);
  await assert.rejects(fs.access(path.join(quiet.run, 'stop-incomplete.json')));
  // Closing round 5 F1: a failed attempt with no answer whose output stayed open is warned and recorded too.
  const lost = await setup(t);
  await lost.ctl({ finalB, recordB: { status: 'failed', stopIncomplete: true }, codexWait: 1 });
  assert.equal((await lost.rr('phase1', '--run-dir', lost.run, '--start')).code, 0);
  const l = await lost.rr('phase1', '--run-dir', lost.run, '--wait');
  assert.notEqual(l.code, 0, l.out);
  assert.match(l.out, /warning: seat B exited without an answer, but its output stayed open: a process it started may still be running/);
  assert.doesNotMatch(l.out, /ran on past its final answer/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(lost.run, 'stop-incomplete.json'), 'utf8')), { 'seat B (phase1)': true });
});

test('round 6: the seat\'s one "Blocked:" line decides the blind warning; a No findings seat that says it was blocked stops', async (t) => {
  const nl = String.fromCharCode(10);
  const file = (...lines) => ['# Seat B findings', '', ...lines, ''].join(nl);
  // "Blocked: none": a line the wording guess would flag is not a warning.
  const healthy = await setup(t);
  await healthy.ctl({ finalB: file('## B1 — one claim', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', '', '## Checks performed', '- H2: pytest failed: No usable temporary directory found. PARTIAL', 'Blocked: none') });
  assert.equal((await healthy.rr('phase1', '--run-dir', healthy.run, '--start')).code, 0);
  const h = await healthy.rr('phase1', '--run-dir', healthy.run, '--wait');
  assert.equal(h.code, 0, h.out);
  assert.equal(h.lines.some((l) => /seat B .*(?:blind|blocked)/i.test(l)), false, h.out);
  // A declared block is a warning, quoted for the report.
  const blocked = await setup(t);
  await blocked.ctl({ finalB: file('## B1 — one claim', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', '', '## Checks performed', '- AC-1: traced the code. MET', 'Blocked: node --test: the harness was refused by policy') });
  assert.equal((await blocked.rr('phase1', '--run-dir', blocked.run, '--start')).code, 0);
  const b = await blocked.rr('phase1', '--run-dir', blocked.run, '--wait');
  assert.equal(b.code, 0, b.out);
  assert.ok(b.lines.some((l) => /^warning: seat B says it was blocked: "Blocked: node --test: the harness was refused by policy"/.test(l)), b.out);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(blocked.run, 'seat-warnings-phase1.json'), 'utf8')).blind.B, ['Blocked: node --test: the harness was refused by policy']);
  // No findings plus a declared block is an incomplete seat; a claim heading inside a fence does not make it a seat with claims.
  for (const lines of [['## No findings', '', 'Nothing in scope looked wrong.', 'Blocked: every file in the target: EACCES'], ['## No findings', '', '```', '## Q1 — a fixture heading', '```', 'Blocked: every file in the target: EACCES']]) {
    const empty = await setup(t);
    await empty.ctl({ finalB: file(...lines) });
    assert.equal((await empty.rr('phase1', '--run-dir', empty.run, '--start')).code, 0);
    const e = await empty.rr('phase1', '--run-dir', empty.run, '--wait');
    assert.equal(e.code, 1, e.out);
    assert.match(e.out, /seat B: wrote "No findings" but says it was blocked \("Blocked: every file in the target: EACCES"\)/);
    // The next: line agrees with the message: a new run, not a rerun of this --wait.
    const next = e.lines.find((l) => l.startsWith('next:'));
    assert.match(next, /start a new run with the same packet/, e.out);
    assert.doesNotMatch(next, /rerun: review-run phase1/, e.out);
  }
});

test('the strict format: a refused seat file goes back to its seat once (a CLI seat is resumed on its session); refused again, the review is INCOMPLETE', async (t) => {
  const nl = String.fromCharCode(10);
  const file = (...lines) => ['# Seat B findings', '', ...lines, ''].join(nl);
  const s = await setup(t);
  // A block behind a later "Blocked: none" (closing rounds 1-5): refused, never read as clean.
  await s.ctl({ finalB: file('## No findings', 'Blocked: none', '**Blocked:** rg missing') });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const first = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(first.code, 3, first.out);
  assert.match(first.out, /seat B: its file was refused \(1 reason\(s\), e\.g\. line 5: "\*\*Blocked:\*\* rg missing" says "blocked:"/);
  assert.match(first.out, /seat B rewrites its refused findings file \(one rewrite/);
  const rewrite = (await s.calls()).filter((c) => c.script === 'codex-dispatch.mjs' && c.argv.includes('--detach')).at(-1);
  assert.equal(s.flag(rewrite, '--session'), 'thread-B', 'the seat is resumed on its Phase 1 session');
  assert.equal(s.flag(rewrite, '--brief'), path.join(s.run, 'phase1', 'B', 'rewrite-brief.txt'));
  assert.equal(s.flag(rewrite, '--previous-result'), path.join(s.run, 'phase1', 'B', 'result.before-rewrite.json'));
  const brief = await fs.readFile(path.join(s.run, 'phase1', 'B', 'rewrite-brief.txt'), 'utf8');
  assert.match(brief, /refused by the review's format check:\n- line 5: .*\n/);
  assert.match(brief, /Reply with the whole file again as your final message/);
  assert.match(brief, /Your final message is the whole file and nothing else\./);
  assert.match(brief, /every claim has a "Same shape elsewhere:" line .*Add a missing required line; change nothing else/, 'the seat may add a required line it left out');
  assert.doesNotMatch(brief, /word written/, 'a final-message seat is never told to reply "written"');
  assert.equal(await fs.readFile(path.join(s.run, 'phase1', 'B-findings.refused.md'), 'utf8'), file('## No findings', 'Blocked: none', '**Blocked:** rg missing'), 'the refused file is kept');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(s.run, 'phase1', 'rewrites.json'), 'utf8'))), ['B']);
  // The fake seat answers the same wrong file again: refused after its one rewrite, the step fails and names INCOMPLETE.
  const again = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /FAILED seat format: seat B's file was refused again after its one rewrite .*: the review is INCOMPLETE/);
  assert.match(again.lines.at(-1), /^next: report the review as INCOMPLETE/);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(s.run, 'phase1', 'format-refused.json'), 'utf8'))), ['B']);
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: INCOMPLETE: seat B's findings file was refused again after its one rewrite/);
  // Restructure round 1 F1: once the manifest is written, status still names the refusal; an incomplete manifest says so.
  await fs.writeFile(path.join(s.run, 'manifest.json'), JSON.stringify({ run_id: 'r', status: 'incomplete' }));
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: INCOMPLETE: seat B's findings file was refused again after its one rewrite .*; manifest\.json is written/);
  await fs.rm(path.join(s.run, 'phase1', 'format-refused.json'));
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: finished INCOMPLETE: manifest\.json status is "incomplete"/);
  await fs.writeFile(path.join(s.run, 'manifest.json'), JSON.stringify({ run_id: 'r', status: 'completed' }));
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: finished: manifest\.json is written/);
  // A corrected rewrite passes: the run goes on to validate.
  const fixed = await setup(t);
  await fixed.ctl({ finalB: file('## No findings', 'Blocked:none') });
  assert.equal((await fixed.rr('phase1', '--run-dir', fixed.run, '--start')).code, 0);
  // The fake seat answers the rewrite as soon as it is resumed, with this corrected file.
  await fixed.ctl({ finalB: file('## No findings', 'Blocked: none') });
  assert.equal((await fixed.rr('phase1', '--run-dir', fixed.run, '--wait')).code, 3);
  const ok = await fixed.rr('phase1', '--run-dir', fixed.run, '--wait');
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.lines.some((l) => /^validate Phase 1: clean/.test(l)), ok.out);
  // A native seat gets a message file instead of a dispatch.
  const native = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await native.rr('phase1', '--run-dir', native.run, '--start')).code, 0);
  await fs.writeFile(path.join(native.run, 'phase1', 'A-findings.md'), file('## A1 — x', 'Severity: LOW'));
  const n = await native.rr('phase1', '--run-dir', native.run, '--wait', '--native-done', 'A');
  assert.equal(n.code, 3, n.out);
  assert.match(n.out, /seat A: its file was refused .*no "## Checks performed" heading after the claims.*send its agent the message in .*prompt-rewrite-A\.txt/);
  assert.match(await fs.readFile(path.join(native.run, 'phase1', 'prompt-rewrite-A.txt'), 'utf8'), /Write it again to .*A-findings\.md in one write/);
  // A rewrite that ends badly is dispatched again as the rewrite, on the same session, not as a new Phase 1 pass.
  const failing = await setup(t);
  await failing.ctl({ finalB: file('## No findings') });
  assert.equal((await failing.rr('phase1', '--run-dir', failing.run, '--start')).code, 0);
  await failing.ctl({ finalB: file('## No findings'), recordB: { status: 'failed' } });
  assert.equal((await failing.rr('phase1', '--run-dir', failing.run, '--wait')).code, 3);
  await failing.ctl({ finalB: file('## No findings', 'Blocked: none') });
  const retried = await failing.rr('phase1', '--run-dir', failing.run, '--wait');
  assert.match(retried.out, /seat B: previous attempt ended with status failed; dispatched again/, retried.out);
  const redo = (await failing.calls()).filter((c) => c.script === 'codex-dispatch.mjs' && c.argv.includes('--detach')).at(-1);
  assert.equal(failing.flag(redo, '--brief'), path.join(failing.run, 'phase1', 'B', 'rewrite-brief.txt'));
  assert.equal(failing.flag(redo, '--session'), 'thread-B');
  // Restructure round 1 F8: a rewrite that failed before its CLI reported a session id is still sent on the Phase 1 session.
  const early = await setup(t);
  await early.ctl({ finalB: file('## No findings') });
  assert.equal((await early.rr('phase1', '--run-dir', early.run, '--start')).code, 0);
  await early.ctl({ finalB: file('## No findings'), recordB: { status: 'failed', threadId: null } });
  assert.equal((await early.rr('phase1', '--run-dir', early.run, '--wait')).code, 3);
  await early.ctl({ finalB: file('## No findings', 'Blocked: none') });
  const resent = await early.rr('phase1', '--run-dir', early.run, '--wait');
  assert.doesNotMatch(resent.out, /no session id/, resent.out);
  const resentCall = (await early.calls()).filter((c) => c.script === 'codex-dispatch.mjs' && c.argv.includes('--detach')).at(-1);
  assert.equal(early.flag(resentCall, '--brief'), path.join(early.run, 'phase1', 'B', 'rewrite-brief.txt'));
  assert.equal(early.flag(resentCall, '--session'), 'thread-B');
  assert.equal(early.flag(resentCall, '--previous-result'), path.join(early.run, 'phase1', 'B', 'result.before-rewrite.json'));
  // A rewrite that cannot be sent (no session to resume) leaves the run as it was: no rewrite is recorded, the file stays.
  const nosession = await setup(t);
  await nosession.ctl({ finalB: file('## No findings'), recordB: { threadId: null } });
  assert.equal((await nosession.rr('phase1', '--run-dir', nosession.run, '--start')).code, 0);
  const ns = await nosession.rr('phase1', '--run-dir', nosession.run, '--wait');
  assert.equal(ns.code, 1, ns.out);
  assert.match(ns.out, /FAILED resume seat B: no session id/);
  assert.equal(await fs.readFile(path.join(nosession.run, 'phase1', 'B-findings.md'), 'utf8'), file('## No findings'), 'the refused file is back in place');
  await assert.rejects(fs.access(path.join(nosession.run, 'phase1', 'rewrites.json')), 'no rewrite was used');
  // A Claude file-channel seat: its rewrite lands in its private file and is published again over the refused one.
  const claude = await setup(t);
  const badA = ['# Seat A findings', '', '## A1 — x', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', ''].join(nl);
  const goodA = ['# Seat A findings', '', '## A1 — x', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', '', '## Checks performed', '- AC-1: ok. MET', 'Blocked: none', ''].join(nl);
  await claude.ctl({ finalA: badA });
  assert.equal((await claude.rr('phase1', '--run-dir', claude.run, '--start')).code, 0);
  await claude.ctl({ finalA: goodA });
  const c1 = await claude.rr('phase1', '--run-dir', claude.run, '--wait');
  assert.equal(c1.code, 3, c1.out);
  assert.match(c1.out, /seat A: its file was refused .*resumed once to rewrite it/);
  assert.match(await fs.readFile(path.join(claude.run, 'phase1', 'A', 'rewrite-brief.txt'), 'utf8'), /Write it again to .*seat-A[\\/]A-findings\.md in one write[\s\S]*Reply with only the word written/);
  const c2 = await claude.rr('phase1', '--run-dir', claude.run, '--wait');
  assert.equal(c2.code, 0, c2.out);
  assert.equal(await fs.readFile(path.join(claude.run, 'phase1', 'A-findings.md'), 'utf8'), goodA, 'the rewrite is published');
  assert.equal(await fs.readFile(path.join(claude.run, 'phase1', 'A-findings.refused.md'), 'utf8'), badA, 'the refused file is kept');
});

test('Linux round linux-r1 F6: a claim-level defect (a missing field, a bad value, an unclosed fence) gets the one rewrite too', async (t) => {
  const nl = String.fromCharCode(10);
  const good = ['# Seat A findings', '', '## A1 — x', 'Severity: LOW', 'Basis: STATIC_TRACE', 'Evidence strength: DETERMINISTIC', 'Evidence:', 'x.js:1', 'Same shape elsewhere: none found', '', '## Checks performed', '- AC-1: ok. MET', 'Blocked: none', ''].join(nl);
  for (const [name, bad, reason] of [
    ['missing Basis', good.replace(`Basis: STATIC_TRACE${nl}`, ''), /no recognized "Basis:" line/],
    ['bad Severity', good.replace('Severity: LOW', 'Severity: SEVERE'), /Severity value "SEVERE" is not exactly one of/],
    ['unclosed fence', good.replace(`Evidence:${nl}x.js:1`, `Evidence:${nl}\`\`\`${nl}x.js:1`), /unterminated fenced code block/],
  ]) {
    const s = await setup(t);
    await s.ctl({ finalA: bad });
    assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
    await s.ctl({ finalA: good });
    const first = await s.rr('phase1', '--run-dir', s.run, '--wait');
    assert.equal(first.code, 3, `${name}: ${first.out}`);
    assert.match(first.out, /seat A: its file was refused .*resumed once to rewrite it/, name);
    assert.match(JSON.parse(await fs.readFile(path.join(s.run, 'phase1', 'rewrites.json'), 'utf8')).A.problems.join(' | '), reason, name);
    const second = await s.rr('phase1', '--run-dir', s.run, '--wait');
    assert.equal(second.code, 0, `${name}: ${second.out}`);
  }
});

test('phase1 --wait: a CLI seat B that wrote "No findings" after its commands failed fails the step instead of validating clean', async (t) => {
  const nl = String.fromCharCode(10);
  // "Blocked: none" with a stderr that shows no command could start is incomplete (a mechanical check, not wording).
  const e = await setup(t);
  await e.ctl({ finalB: ['# Seat B findings', '', '## No findings', '', 'Blocked: none', ''].join(nl) });
  assert.equal((await e.rr('phase1', '--run-dir', e.run, '--start')).code, 0);
  const record = JSON.parse(await fs.readFile(path.join(e.run, 'phase1', 'B', 'result.json'), 'utf8').catch(() => '{}'));
  await fs.writeFile(record.stderrLog ?? path.join(e.run, 'phase1', 'B', 'result.stderr.log'), 'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "x" }\n');
  const er = await e.rr('phase1', '--run-dir', e.run, '--wait');
  assert.equal(er.code, 1, er.out);
  assert.match(er.out, /seat B: wrote "No findings" but its stderr shows "exec_command failed"/);
  assert.equal((await e.calls()).some((c) => c.script === 'blind-relabel.mjs'), false, 'validate must not run');
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
  const one = 'ERROR error=exec_command failed: CreateProcess { message: "Failed to create unified exec process: x" }';
  assert.equal(execFailureCount(one), 1, 'one failed command is one failure even when its line matches three patterns');
});


test('parseArgs: --max-wait 0 is refused, because a dispatcher reads 0 as no limit', () => {
  assert.throws(() => parseArgs(['phase1', '--run-dir', 'r', '--wait', '--max-wait', '0']), /--max-wait must be a whole number of seconds, at least 1/);
  assert.equal(parseArgs(['phase1', '--run-dir', 'r', '--wait', '--max-wait', '1']).maxWait, 1);
});

test('phase1 --wait: a NATIVE seat that wrote "No findings" with no Blocked: line is sent back to rewrite, never passed as clean', async (t) => {
  const s = await setup(t, { seatA: { transport: 'native' } });
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  const nl = String.fromCharCode(10);
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), ['# Seat A findings', '', '## No findings', '', 'Review incomplete. I could not read the target.', ''].join(nl));
  const r = await s.rr('phase1', '--run-dir', s.run, '--wait', '--max-wait', '1', '--native-done', 'A');
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /seat A: its file was refused \(1 reason\(s\), e\.g\. "## No findings" has no line "Blocked: none"/);
  assert.equal((await s.calls()).some((c) => c.script === 'blind-relabel.mjs' && c.argv[0] === 'validate'), false, 'validate must not run');
});

test('audit --finish: verification files of a run that started without falsification are staged and reported, never silently ignored', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.mkdir(path.join(s.run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const finish = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.ok(finish.lines.some((l) => /auditor brief: built \(every claim is re-checked, 1 verification file\(s\) staged\)/.test(l)), finish.out);
  const on = await setup(t, { flags: { falsification: true } });
  assert.equal((await on.rr('audit', '--run-dir', on.run, '--prepare')).code, 0);
  assert.equal((await on.rr('audit', '--run-dir', on.run, '--finish')).lines.some((l) => /are ignored because/.test(l)), false);
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
  // Linux round O2: the exchange's own refusal line is a reason, not progress.
  const leak = ['exchange: validate both seats', 'relabeled A -> P, wrote x', 'exchange: seat A\'s file still names the run folder (/r/run, which resolves into it); return it to the seat to cite the path another way', 'exchange: scan peer-view-for-A.md', 'scan clean: 0 identity matches', 'relabeled B -> P, wrote y', 'build-brief: wrote a', 'build-brief: wrote b', 'build-brief: wrote c', 'exchange.mjs: no brief was built'].join(String.fromCharCode(10));
  const detail = failureDetail(leak);
  assert.match(detail, /reasons: .*seat A's file still names the run folder \(\/r\/run/, 'kept also when more lines follow it');
  assert.equal(detail.split(' | ').length - 1, 4, detail);
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
  // Restructure round 2 F4: a warning in the middle survives the cap; routine progress lines go first, order is kept.
  const capped = [];
  print({ lines: [...Array.from({ length: 9 }, (_, i) => `progress ${i + 1}`), 'warning: seat B left a process running', ...Array.from({ length: 3 }, (_, i) => `later ${i + 1}`), 'FAILED exchange: boom'], next: 'fix it' }, { write: (t) => capped.push(t) });
  const shown = capped.join('').split(nl).filter(Boolean);
  assert.equal(shown.length, 11);
  assert.ok(shown.includes('warning: seat B left a process running'), shown.join(' | '));
  assert.ok(shown.indexOf('progress 1') < shown.indexOf('warning: seat B left a process running'), 'kept lines stay in order');
  assert.equal(shown.at(-2), 'FAILED exchange: boom');
  assert.equal(shown.at(-3), '... 5 more line(s) omitted');
  // Restructure round 3 F1: more warnings than room: none is dropped, the overflow shares one line.
  const many = [];
  print({ lines: [...Array.from({ length: 12 }, (_, i) => `warning: number ${i + 1}`), 'progress x', 'FAILED exchange: boom'], next: 'fix it' }, { write: (t) => many.push(t) });
  const manyShown = many.join('').split(nl).filter(Boolean);
  assert.equal(manyShown.length, 11);
  assert.equal(manyShown.at(-2), 'FAILED exchange: boom');
  for (let i = 1; i <= 12; i += 1) assert.ok(manyShown.join('\n').includes(`warning: number ${i}`), `warning ${i} is shown`);
  assert.match(manyShown.at(-3), /^4 more warning\(s\): warning: number 9 \| /);
  // Pair review F3 and F11: every overflow warning keeps its start however long the others are, and the progress lines
  // left out are counted.
  for (const count of [9, 12, 30]) {
    for (const length of [20, 250, 2000]) {
      const got = [];
      const warnings = Array.from({ length: count }, (_, i) => `warning: n${i + 1}#${'x'.repeat(length)}`);
      print({ lines: [...warnings, 'progress a', 'progress b', 'FAILED exchange: boom'], next: 'fix it' }, { write: (t) => got.push(t) });
      const text = got.join('');
      for (let i = 1; i <= count; i += 1) assert.ok(text.includes(`warning: n${i}#`), `${count}x${length}: warning ${i} is shown`);
      assert.match(text.split(nl).filter(Boolean).at(-3), /; 2 more line\(s\) omitted$/, `${count}x${length}`);
    }
  }
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1 - x\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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
  await fs.writeFile(path.join(s.run, 'phase1', 'A-findings.md'), '## A1 - x\nSeverity: LOW\nBasis: STATIC_TRACE\nEvidence strength: DETERMINISTIC\nEvidence:\nclaim\nSame shape elsewhere: none found\n\n## Checks performed\nBlocked: none\n');
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

test('audit --finish with falsification: a verification file for another claim does not cover the claim that qualified, even when the count matches [slow]', async (t) => {
  const s = await setup(t, { flags: { falsification: true } });
  await s.ctl({ qualified: 1, qualifiedIds: ['Y1'] });
  assert.equal((await s.rr('audit', '--run-dir', s.run, '--prepare')).code, 0);
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-X1.md'), 'verified\n');
  const wrong = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(wrong.code, 1, wrong.out + wrong.err);
  assert.match(wrong.lines.at(-2), /no verification file names Y1/);
  await fs.writeFile(path.join(s.run, 'phase3', 'verification-Y1.md'), 'verified\n');
  const right = await s.rr('audit', '--run-dir', s.run, '--finish');
  assert.equal(right.code, 0, right.out + right.err);
});

test('manifest, report, recheck, splice and scan hand their arguments to their step, in-process, with its output and exit code', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-run-forward-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const call = async (...argv) => {
    let out = '';
    let err = '';
    const code = await runInProcess(argv, { stdout: { write: (c) => { out += c; } }, stderr: { write: (c) => { err += c; } } });
    return { code, out, err };
  };
  const missing = path.join(dir, 'missing');
  const manifest = await call('manifest', '--run-dir', missing);
  assert.equal(manifest.code, 1);
  assert.match(manifest.err, /^build-manifest: /);
  assert.equal((await call('manifest', '--bogus')).code, 2);
  const help = await call('report', '--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /^ {2}node review-run\.mjs report +--run-dir <dir> \[--format text\|chat/, 'a forwarded command answers --help with its usage line');
  // Pair review F9 and F6: each phase command's synopsis names every option its parser takes, and the ten-line cap is
  // stated for the phase commands only.
  const usage = (await call('--help')).out;
  for (const command of ['phase1', 'phase2', 'audit']) {
    const line = usage.split('\n').find((l) => new RegExp(`^ {2}node review-run\\.mjs ${command} `).test(l)) ?? '';
    for (const option of ['--max-wait', '--native-done', '--native-agent', '--accept-drift', '--local']) assert.ok(line.includes(`[${option}`), `${command} usage names ${option}`);
  }
  assert.match(usage, /phase1, phase2 and audit print at most 10 lines/);
  const report = await call('report', '--run-dir', missing);
  assert.notEqual(report.code, 0);
  assert.match(report.err, /^build-report: /);
  const recheck = await call('recheck', '--from-run', missing, '--out', path.join(dir, 'p.md'));
  assert.equal(recheck.code, 1);
  assert.match(recheck.err, /^build-recheck-packet: cannot read the previous task packet/);
  const seat = path.join(dir, 'A-findings.md');
  await fs.writeFile(seat, '# Seat A findings\n\n## A1 — t\nSeverity: LOW\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nold\n```\n');
  const reply = path.join(dir, 'reply.md');
  await fs.writeFile(reply, '## A1 — t\nSeverity: LOW\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nnew\n```\n');
  const spliced = await call('splice', '--file', seat, '--match-heading', '## A1', '--with', reply);
  assert.equal(spliced.code, 0, spliced.err);
  assert.match(await fs.readFile(seat, 'utf8'), /new/);
  const view = path.join(dir, 'peer-view.md');
  await fs.writeFile(view, '# Peer findings\n\n## P1 — t\nnothing to see\n');
  const scan = await call('scan', '--in', view);
  assert.equal(scan.code, 0, scan.err);
  assert.match(scan.out, /^scan clean/);
  assert.equal((await call('scan', '--in', seat)).code, 1, 'a seat mention stops, as the scan always did');
  const verifier = await call('verifier-brief', '--claim', missing, '--rebuttal', missing, '--target-dir', dir, '--out', path.join(dir, 'v.txt'));
  assert.equal(verifier.code, 1);
  assert.match(verifier.err, /^build-brief: /);
  assert.equal((await call('verifier-brief', '--target-dir', dir, '--out', path.join(dir, 'v.txt'))).code, 1, 'the verifier mode still needs its claim');
});

test('Linux round linux-r2 F1: --incomplete-seat asks a live worker to stop first, so its own cleanup runs', { skip: process.platform === 'win32' }, async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  assert.equal((await s.rr('phase2', '--run-dir', s.run, '--start')).code, 0);
  const { processStartMs, processStartToken, processExists } = await import('../detach-utils.mjs');
  const { spawn } = await import('node:child_process');
  const marker = path.join(s.base, 'cleanup-ran');
  const worker = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(0); }); setInterval(() => {}, 1000);`], { stdio: 'ignore', detached: true });
  t.after(() => { try { worker.kill('SIGKILL'); } catch { /* gone */ } });
  await new Promise((r) => worker.once('spawn', r));
  await new Promise((r) => setTimeout(r, 300));
  await fs.writeFile(path.join(s.run, 'phase2', 'A', 'result.json'), JSON.stringify({ status: 'running', sessionId: 'sess-A', workerPid: worker.pid, workerStartedAt: new Date(processStartMs(worker.pid) ?? Date.now()).toISOString(), workerStartToken: processStartToken(worker.pid), startedAt: new Date().toISOString() }));
  const wait = await s.rr('phase2', '--run-dir', s.run, '--wait', '--incomplete-seat', 'A');
  assert.equal(wait.code, 0, wait.out + wait.err);
  assert.ok(wait.lines.some((l) => /seat A: its Phase 2 worker was still running and was stopped/.test(l)), wait.out);
  assert.equal(await fs.readFile(marker, 'utf8'), 'yes', 'the worker ran its SIGTERM cleanup');
  assert.equal(processExists(worker.pid), false);
});

test('Linux round linux-r2 F7: an empty object is no finished audit, exchange or manifest', async (t) => {
  const s = await setup(t);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--start')).code, 0);
  assert.equal((await s.rr('phase1', '--run-dir', s.run, '--wait')).code, 0);
  await fs.mkdir(path.join(s.run, 'phase3'), { recursive: true });
  for (const file of [path.join(s.run, 'manifest.json'), path.join(s.run, 'phase3', 'findings.json'), path.join(s.run, 'phase2', 'exchange-result.json')]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{}\n');
  }
  const status = (await s.rr('status', '--run-dir', s.run)).lines[0];
  assert.doesNotMatch(status, /audit finished|exchange finished|manifest\.json is written/, status);
  const wait = await s.rr('phase1', '--run-dir', s.run, '--wait');
  assert.doesNotMatch(wait.out, /already done/, wait.out);
});
test('field run: status and report call a manifest built before the finished audit stale, by the findings hash', async (t) => {
  const { createHash } = await import('node:crypto');
  const { loadRun } = await import('../build-report.mjs');
  const s = await setup(t);
  await fs.mkdir(path.join(s.run, 'phase3'), { recursive: true });
  // The failed chain wrote an incomplete manifest before any findings existed; the audit finished later.
  await fs.writeFile(path.join(s.run, 'manifest.json'), JSON.stringify({ status: 'incomplete', run_id: 'old', hashes: {} }));
  const findings = '{"findings":[]}\n';
  await fs.writeFile(path.join(s.run, 'phase3', 'findings.json'), findings);
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: audit finished after manifest\.json was built; next: review-run manifest \(rebuilds it\), then review-run report/);
  const early = await loadRun(s.run);
  assert.ok(early.caveats.some((c) => c.startsWith('manifest.json was built before the current phase3/findings.json')));
  // A stale manifest leaves the report not final, like a missing one, with the stale caveat only.
  assert.equal(early.status, 'NOT FINAL');
  assert.ok(!early.caveats.some((c) => /is not built yet|The review is incomplete/.test(c)), early.caveats.join(' | '));
  const sha = createHash('sha256').update(findings).digest('hex');
  await fs.writeFile(path.join(s.run, 'manifest.json'), JSON.stringify({ status: 'completed', run_id: 'new', hashes: { findings_json: sha } }));
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: finished: manifest\.json is written/);
  const current = await loadRun(s.run);
  assert.ok(!current.caveats.some((c) => c.startsWith('manifest.json was built before')));
  assert.equal(current.status, 'COMPLETE');
  // A completed manifest whose findings hash is another file's is stale too, and never reported COMPLETE.
  await fs.writeFile(path.join(s.run, 'manifest.json'), JSON.stringify({ status: 'completed', run_id: 'new', hashes: { findings_json: 'f'.repeat(64) } }));
  assert.match((await s.rr('status', '--run-dir', s.run)).lines[0], /: audit finished after manifest\.json was built/);
  const stale = await loadRun(s.run);
  assert.ok(stale.caveats.some((c) => c.startsWith('manifest.json was built before the current phase3/findings.json')));
  assert.equal(stale.status, 'NOT FINAL');
  assert.ok(!stale.caveats.some((c) => /is not built yet/.test(c)), stale.caveats.join(' | '));
  const { renderChat, renderHtml } = await import('../build-report.mjs');
  assert.match(renderChat(stale), /^> \*\*REVIEW NOT FINAL /);
  assert.match(renderHtml(stale), /<span class="status incomplete">NOT FINAL<\/span>/);
});

test('status: a re-audit after manifest.json was built is pending until audit --finish passes, not finished', async (t) => {
  const { createHash } = await import('node:crypto');
  const s = await setup(t);
  const p3 = path.join(s.run, 'phase3');
  await fs.mkdir(p3, { recursive: true });
  const findings = '{"findings":[]}\n';
  const sha = createHash('sha256').update(findings).digest('hex');
  await fs.writeFile(path.join(s.run, 'manifest.json'), JSON.stringify({ status: 'completed', run_id: 'r', hashes: { findings_json: sha } }));
  // audit --finish moved the findings aside for the resumed auditor's file, and translate refused that file.
  await fs.writeFile(path.join(p3, 'findings.attempt-1.json'), findings);
  await fs.writeFile(path.join(p3, 'prompt-auditor-fix.txt'), 'Your audit file was refused.\n');
  const status = async () => (await s.rr('status', '--run-dir', s.run)).lines[0];
  assert.match(await status(), /: audit: the auditor is working or its output waits for audit --finish \(a re-audit after manifest\.json was built\)/);
  // A refused audit file with nothing moved aside is not a re-audit.
  await fs.rename(path.join(p3, 'findings.attempt-1.json'), path.join(s.run, 'kept-attempt.json'));
  assert.match(await status(), /: audit: the auditor is working or its output waits for audit --finish \(the auditor's file was refused after manifest\.json was built\)/);
  await fs.rename(path.join(s.run, 'kept-attempt.json'), path.join(p3, 'findings.attempt-1.json'));
  // translate crashed instead: no fix message, the findings still moved aside.
  await fs.rm(path.join(p3, 'prompt-auditor-fix.txt'));
  assert.match(await status(), /: audit: the auditor is working or its output waits for audit --finish \(a re-audit after manifest\.json was built\)/);
  // audit --finish passed: fresh findings beside the kept attempt, and the manifest's hash is theirs.
  await fs.writeFile(path.join(p3, 'findings.json'), findings);
  assert.match(await status(), /: finished: manifest\.json is written/);
});
