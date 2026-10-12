import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveHost, missingDispatchers, leanFlagGaps, codexSandboxFailure } from '../preflight.mjs';
import { readRunDescriptor } from '../run-descriptor.mjs';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));
const SKILL = path.basename(path.dirname(path.resolve(SCRIPTS)));
const LEAN = [
  '--restricted', '--setting-sources', '--strict-mcp-config', '--disable-slash-commands', '--tools', '--add-dir',
  '--allowedTools', '--permission-mode', '--append-system-prompt', '--resume', '--output-format', '--model',
];
const HELP = `Usage: claude [options]\n${LEAN.map((flag) => `  ${flag} <value>  option`).join('\n')}\n`;

const FAKE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const here = path.dirname(fileURLToPath(import.meta.url));',
  'const argv = process.argv.slice(2);',
  "fs.appendFileSync(path.join(here, 'calls.log'), argv.join(' ') + '\\n');",
  "if (argv.includes('--help')) { process.stdout.write(fs.readFileSync(path.join(here, 'help.txt'), 'utf8')); process.exit(0); }",
  "let input = ''; for await (const chunk of process.stdin) input += chunk;",
  "const resuming = argv.includes('--resume');",
  "if (resuming && fs.existsSync(path.join(here, 'no-persist.flag'))) { process.stderr.write('No conversation found with session ID: ' + argv[argv.indexOf('--resume') + 1] + '\\n'); process.exit(1); }",
  "const remembered = /Remember this nonce: (\\S+)\\./.exec(input); if (remembered) fs.writeFileSync(path.join(here, 'nonce.txt'), remembered[1]);",
  "const answer = resuming && fs.existsSync(path.join(here, 'nonce.txt')) ? fs.readFileSync(path.join(here, 'nonce.txt'), 'utf8') : 'ok';",
  'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
  "emit({ type: 'system', subtype: 'init', session_id: 'probe-session', model: 'claude-probe-model' });",
  "emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'probe-session', result: answer, total_cost_usd: 0.004, usage: { input_tokens: 5, output_tokens: 2 }, permission_denials: [] });",
  '',
].join('\n');

// A pair-review run needs two seats of one vendor; cross-review needs a Claude seat A and a Codex seat B.
const DEFAULT_SEAT_B = SKILL === 'pair-review' ? { model: 'sonnet' } : { provider: 'openai', runtime: 'codex', model: 'gpt-5.5' };
const CROSS_SEAT_B = { provider: 'openai', runtime: 'codex', model: 'gpt-5.5' };
// A host layout with Codex seats the skill accepts: Claude seat A plus Codex seat B, or two Codex models for a pair.
const CODEX_SEATS = SKILL === 'pair-review'
  ? { seatA: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-sol', transport: 'cli' }, seatB: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-terra', transport: 'cli' }, auditor: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-sol', transport: 'cli' } }
  : { seatB: CROSS_SEAT_B };

async function harness(t, { help = HELP, scriptsDir = SCRIPTS, seatA = {}, seatB = DEFAULT_SEAT_B, auditor = { transport: 'native' } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight host '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  await fs.mkdir(bin);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'file.txt'), 'content\n');
  await fs.writeFile(path.join(bin, 'fake.mjs'), FAKE);
  await fs.writeFile(path.join(bin, 'help.txt'), help);
  const shim = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  await fs.writeFile(shim, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${path.join(bin, 'fake.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake.mjs')}" "$@"\n`, { mode: 0o755 });
  const locator = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' });
  const gitDir = path.dirname(locator.stdout.trim().split(/\r?\n/)[0]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + gitDir;
  const run = path.join(dir, 'run');
  const actor = (role, extra = {}) => ({
    provider: 'anthropic', runtime: 'claude', model: 'opus', transport: 'cli', ...extra, role,
  });
  const seats = {
    seatA: actor('A', seatA),
    seatB: actor('B', seatB),
    auditor: actor('auditor', auditor),
  };
  const seatsFile = path.join(dir, 'seats.json');
  await fs.writeFile(seatsFile, JSON.stringify(seats));
  const launch = (extra = [], { seatsPath = seatsFile, runDir = run } = {}) => spawnSync(
    process.execPath,
    [path.join(scriptsDir, 'preflight.mjs'), '--host', 'claude-code', '--cd', target, '--run-dir', runDir, '--seats', seatsPath, ...extra],
    { encoding: 'utf8', env },
  );
  const calls = async () => (await fs.readFile(path.join(bin, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { dir, bin, target, run, seats, seatsFile, launch, calls };
}

test('resolveHost: both families present is ambiguous, a non-contradicting --host wins, one family decides, none is ambiguous', () => {
  const pick = (args) => resolveHost({ interactive: true, env: {}, ...args });
  assert.equal(pick({ toolsClaudeCode: true, toolsCodex: true }), 'ambiguous');
  assert.equal(pick({ toolsClaudeCode: true, toolsCodex: true, hostFlag: 'codex' }), 'codex');
  assert.equal(pick({ toolsClaudeCode: true, toolsCodex: false, hostFlag: 'claude-code' }), 'claude-code');
  assert.equal(pick({ toolsClaudeCode: true }), 'claude-code');
  assert.equal(pick({ toolsCodex: true }), 'codex');
  assert.equal(pick({}), 'ambiguous');
  assert.equal(pick({ hostFlag: 'codex' }), 'codex', 'no recognised tools: the flag decides');
  assert.equal(pick({ toolsClaudeCode: true, hostFlag: 'codex' }), 'claude-code', 'a flag that contradicts the only present family does not win');
  assert.throws(() => pick({ hostFlag: 'gemini' }), /--host must be one of claude-code, codex/);
});

test('resolveHost: ambiguity in a non-interactive run throws "pass --host"; inherited markers are hints and never decide', () => {
  assert.throws(() => resolveHost({ interactive: false, env: {} }), /pass --host/);
  assert.throws(() => resolveHost({ toolsClaudeCode: true, toolsCodex: true, interactive: false, env: {} }), /both a Claude Code and a Codex/);
  assert.throws(() => resolveHost({ interactive: false, env: { CODEX_THREAD_ID: 'x', CLAUDECODE: '1' } }), /pass --host.*hint only.*CODEX_THREAD_ID is set, CLAUDECODE is set/);
  assert.equal(resolveHost({ interactive: true, env: { CODEX_THREAD_ID: 'x' } }), 'ambiguous');
  assert.equal(resolveHost({ toolsClaudeCode: true, interactive: false, env: { CODEX_THREAD_ID: 'x' } }), 'claude-code');
});

test('missingDispatchers: every runtime used by a seat or the auditor needs its dispatcher, and only those', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatchers '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seats = (a, b, auditor) => ({ seatA: { runtime: a }, seatB: { runtime: b }, auditor: { runtime: auditor } });
  assert.deepEqual(missingDispatchers(seats('claude', 'codex', 'claude'), dir), ['claude-dispatch.mjs', 'codex-dispatch.mjs']);
  assert.deepEqual(missingDispatchers(seats('claude', 'opencode', 'claude'), dir), ['claude-dispatch.mjs', 'opencode-dispatch.mjs']);
  assert.deepEqual(missingDispatchers(seats('claude', 'claude', 'claude'), dir), ['claude-dispatch.mjs']);
  assert.deepEqual(missingDispatchers(seats('codex', 'codex', 'codex'), dir), ['codex-dispatch.mjs']);
  await fs.writeFile(path.join(dir, 'claude-dispatch.mjs'), '');
  await fs.writeFile(path.join(dir, 'codex-dispatch.mjs'), '');
  assert.deepEqual(missingDispatchers(seats('claude', 'codex', 'claude'), dir), []);
  assert.deepEqual(missingDispatchers(seats('codex', 'codex', 'codex'), dir), []);
});

test('leanFlagGaps reads whole flag names: --tools is not satisfied by --allowedTools', () => {
  assert.deepEqual(leanFlagGaps(HELP), []);
  assert.deepEqual(leanFlagGaps(HELP.replace('--restricted', '--other')), ['--restricted']);
  assert.deepEqual(leanFlagGaps(HELP.replace('  --tools <value>  option\n', '')), ['--tools']);
});

test('--host writes run.json with the descriptor fields, the fingerprint and the matched tools, and spends nothing [slow]', async (t) => {
  const h = await harness(t);
  const r = h.launch(['--matched-tools', 'Agent, SendMessage']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.host, 'claude-code');
  assert.equal(out.leanFlags, 'ok');
  const desc = await readRunDescriptor(h.run);
  assert.equal(desc.skill, SKILL);
  assert.equal(desc.targetDir, path.resolve(h.target));
  assert.deepEqual(desc.flags, { auditDepth: 'light', falsification: false, mode: 'adversarial' });
  assert.equal(desc.matchedTools, 'Agent, SendMessage');
  assert.equal(desc.seatA.outputDir, path.join(path.resolve(h.run), 'phase1', 'seat-A'));
  assert.equal(desc.auditor.outputDir, `${path.resolve(h.run)}-audit-input`);
  assert.equal(desc.seatB.sessionId, null);
  assert.match(desc.fingerprint.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(desc.fingerprint.head, null, 'a plain folder has no HEAD');
  const bytes = await fs.readFile(path.join(h.run, 'run.json'));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(await h.calls(), ['-p --help'], 'the only claude call is the free help check');
});

test('--host records HEAD, the diff hash and the untracked hash for a git target [slow]', async (t) => {
  const h = await harness(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: h.target, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  await fs.writeFile(path.join(h.target, 'file.txt'), 'changed\n');
  await fs.writeFile(path.join(h.target, 'new.txt'), 'untracked\n');
  const r = h.launch();
  assert.equal(r.status, 0, r.stderr);
  const { fingerprint } = await readRunDescriptor(h.run);
  assert.match(fingerprint.head, /^[0-9a-f]{40}$/);
  assert.match(fingerprint.diffSha256, /^[0-9a-f]{64}$/);
  assert.match(fingerprint.untrackedSha256, /^[0-9a-f]{64}$/);
});

test('a Claude CLI whose help lacks a lean flag stops the check, names the flag and writes no run.json', async (t) => {
  const h = await harness(t, { help: HELP.replace('--disable-slash-commands', '--other').replace('--resume', '--other2') });
  const r = h.launch();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not list: --disable-slash-commands, --resume/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
});

test('an existing run.json is never overwritten [slow]', async (t) => {
  const h = await harness(t);
  assert.equal(h.launch().status, 0);
  const before = await fs.readFile(path.join(h.run, 'run.json'));
  const r = h.launch();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to overwrite/);
  assert.deepEqual(await fs.readFile(path.join(h.run, 'run.json')), before);
});

test('a malformed seats file or a missing actor is refused before run.json is written [slow]', async (t) => {
  const h = await harness(t);
  const bad = path.join(h.dir, 'bad.json');
  await fs.writeFile(bad, '{ not json');
  assert.match(h.launch([], { seatsPath: bad }).stderr, /cannot be read as JSON/);
  const { auditor, ...rest } = h.seats;
  await fs.writeFile(bad, JSON.stringify(rest));
  assert.match(h.launch([], { seatsPath: bad }).stderr, /"auditor" must be an object/);
  await fs.writeFile(bad, JSON.stringify({ ...h.seats, seatB: { ...h.seats.seatB, runtime: 'nope' } }));
  assert.match(h.launch([], { seatsPath: bad }).stderr, /unknown runtime "nope"/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
});

test('a host value outside claude-code and codex is refused, and host-only flags need --host', async (t) => {
  const h = await harness(t);
  const bad = spawnSync(process.execPath, [path.join(SCRIPTS, 'preflight.mjs'), '--host', 'gemini', '--cd', h.target, '--run-dir', h.run, '--seats', h.seatsFile], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--host must be one of claude-code, codex/);
  const stray = spawnSync(process.execPath, [path.join(SCRIPTS, 'preflight.mjs'), '--cd', h.target, '--run-dir', h.run], { encoding: 'utf8' });
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /only accepted with --host/);
});

test('a skill folder without the dispatcher the seats need is refused with the file names', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill copy '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'cross-review', 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  for (const name of ['preflight.mjs', 'env-filter.mjs', 'snapshot-utils.mjs', 'spawn-utils.mjs', 'run-descriptor.mjs', 'provider-catalog.mjs', 'review-config.mjs', 'host-support.mjs']) {
    await fs.copyFile(path.join(SCRIPTS, name), path.join(scripts, name));
  }
  const h = await harness(t, { scriptsDir: scripts, seatB: CROSS_SEAT_B });
  const r = h.launch();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lacks claude-dispatch\.mjs, codex-dispatch\.mjs/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  assert.deepEqual(await h.calls(), [], 'the dispatcher check runs before any claude call');
});

test('--probe-dispatch alone prints the dispatch it would run and runs nothing', async (t) => {
  const h = await harness(t);
  const r = h.launch(['--probe-dispatch']);
  assert.equal(r.status, 0, r.stderr);
  const { probe } = JSON.parse(r.stdout);
  assert.equal(probe.ran, false);
  assert.match(probe.wouldRun[0], /claude-dispatch\.mjs --brief .*--model haiku .*--no-isolate/);
  assert.deepEqual(await h.calls(), ['-p --help']);
  await assert.rejects(fs.access(path.join(h.run, 'probe')));
});

test('--probe-dispatch --yes-paid runs one probe on the cheapest model and records its cost in the run directory [slow]', async (t) => {
  const h = await harness(t);
  const r = h.launch(['--probe-dispatch', '--yes-paid']);
  assert.equal(r.status, 0, r.stderr);
  const { probe } = JSON.parse(r.stdout);
  assert.equal(probe.ran, true);
  assert.equal(probe.cost.costUsd, 0.004);
  const cost = JSON.parse(await fs.readFile(path.join(h.run, 'probe', 'cost.json'), 'utf8'));
  assert.equal(cost.modelResolved, 'claude-probe-model');
  const calls = await h.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^-p --output-format stream-json --verbose --model haiku /);
  assert.match(calls[1], /--restricted/);
});

async function acceptSample(t, sample, label) {
  const h = await harness(t);
  const seatsPath = path.join(h.dir, 'sample-seats.json');
  await fs.writeFile(seatsPath, JSON.stringify(sample));
  const r = h.launch([], { seatsPath });
  assert.equal(r.status, 0, `${label}: ${r.stderr}`);
  const desc = await readRunDescriptor(h.run);
  assert.equal(desc.seatA.role, 'A');
  assert.deepEqual(Object.keys(desc.flags).sort(), ['auditDepth', 'falsification', 'mode']);
}

test('every json sample in references/hosts/claude-code.md parses and passes the validation preflight --host uses [slow]', async (t) => {
  const text = await fs.readFile(path.join(SCRIPTS, '..', 'references', 'hosts', 'claude-code.md'), 'utf8');
  const samples = [...text.matchAll(/^```json\r?\n([\s\S]*?)^```/gm)].map((m) => JSON.parse(m[1]));
  assert.ok(samples.length >= 1, 'the host file holds at least one seats.json sample');
  for (const [i, sample] of samples.entries()) {
    assert.deepEqual(Object.keys(sample).sort(), ['auditor', 'flags', 'seatA', 'seatB'], `sample ${i}`);
    await acceptSample(t, sample, `host file sample ${i}`);
  }
});

test('the seats sample in preflight --help parses and passes the same validation [slow]', async (t) => {
  const help = spawnSync(process.execPath, [path.join(SCRIPTS, 'preflight.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const lines = help.stdout.split('\n');
  const at = lines.findIndex((l) => /^\s*Example seats file:\s*$/.test(l));
  assert.ok(at >= 0, 'the help text has an "Example seats file:" block');
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line)) break;
    block.push(line);
  }
  await acceptSample(t, JSON.parse(block.join('\n')), 'help sample');
});

test('--host with no Claude actor: an OpenAI pair skips the Claude help check; cross-review refuses two OpenAI seats before run.json', async (t) => {
  const h = await harness(t);
  const codex = (role, model) => ({ provider: 'openai', runtime: 'codex', model, transport: 'cli', role });
  const seatsPath = path.join(h.dir, 'openai-seats.json');
  await fs.writeFile(seatsPath, JSON.stringify({ seatA: codex('A', 'gpt-5.6-sol'), seatB: codex('B', 'gpt-5.6-terra'), auditor: codex('auditor', 'gpt-5.6-sol') }));
  const r = h.launch([], { seatsPath });
  if (SKILL !== 'pair-review') {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cross review requires seat A to run on the Claude harness/);
    await assert.rejects(fs.access(path.join(h.run, 'run.json')));
    assert.deepEqual(await h.calls(), [], 'nothing is called before the layout is refused');
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).leanFlags, 'not needed');
  assert.deepEqual(await h.calls(), [], 'claude is never called');
  const desc = await readRunDescriptor(h.run);
  assert.deepEqual([desc.seatA.runtime, desc.seatB.runtime, desc.auditor.runtime], ['codex', 'codex', 'codex']);
});

test('support per actor: an unsupported route is refused with no override, a trial route needs --allow-trial and is recorded in run.json [slow]', async (t) => {
  const h = await harness(t);
  const refused = h.launch(['--host', 'codex']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /host codex refused: .*actor "auditor" .claude, native.: a native claude agent, but host codex can only start native codex agents/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  const stillRefused = h.launch(['--host', 'codex', '--allow-trial']);
  assert.equal(stillRefused.status, 1, 'no flag opens an unsupported route');
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  const ok = await harness(t);
  const supported = JSON.parse(ok.launch().stdout);
  assert.equal(supported.hostStatus, 'supported');
  assert.deepEqual((await readRunDescriptor(ok.run)).support.map((row) => row.status), ['supported', 'supported', 'supported']);
  const codexNative = (role, model) => ({ provider: 'openai', runtime: 'codex', model, transport: 'native', role });
  const trialSeats = path.join(h.dir, 'trial-seats.json');
  await fs.writeFile(trialSeats, JSON.stringify({ seatA: codexNative('A', 'gpt-5.6-sol'), seatB: codexNative('B', 'gpt-5.6-terra'), auditor: codexNative('auditor', 'gpt-5.6-sol'), flags: { mode: 'collaborate' } }));
  if (SKILL === 'pair-review') {
    const noFlag = h.launch(['--host', 'codex'], { seatsPath: trialSeats });
    assert.equal(noFlag.status, 1);
    assert.match(noFlag.stderr, /actor "A" .codex, native. is a trial route/);
    assert.match(noFlag.stderr, /pass --allow-trial/);
    await assert.rejects(fs.access(path.join(h.run, 'run.json')));
    const trial = h.launch(['--host', 'codex', '--allow-trial'], { seatsPath: trialSeats });
    assert.equal(trial.status, 0, trial.stderr);
    const out = JSON.parse(trial.stdout);
    assert.equal(out.host, 'codex');
    assert.equal(out.hostStatus, 'trial');
    assert.equal(out.leanFlags, 'not needed');
    assert.deepEqual((await readRunDescriptor(h.run)).support.map((row) => row.status), ['trial', 'trial', 'trial']);
  } else {
    const noFlag = h.launch(['--host', 'codex'], { seatsPath: trialSeats });
    assert.equal(noFlag.status, 1, 'cross-review keeps a Claude seat A, so a Codex host has no route for it');
  }
  const stray = spawnSync(process.execPath, [path.join(SCRIPTS, 'preflight.mjs'), '--allow-trial', '--cd', h.target], { encoding: 'utf8' });
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /only accepted with --host/);
});

test('a trial route in a hand-written run.json is refused unless support[] records it; an unsupported route is always refused [slow]', async (t) => {
  const h = await harness(t, { seatB: { provider: 'opencode', runtime: 'opencode', model: 'opencode/x', transport: 'cli' } });
  if (SKILL !== 'cross-review') return;
  const noFlag = h.launch();
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /actor "B" .opencode, cli. is a trial route/);
  const allowed = h.launch(['--allow-trial']);
  assert.equal(allowed.status, 0, allowed.stderr);
  const file = path.join(h.run, 'run.json');
  const desc = JSON.parse(await fs.readFile(file, 'utf8'));
  delete desc.support;
  await fs.writeFile(file, JSON.stringify(desc));
  await assert.rejects(readRunDescriptor(h.run), /is a trial route on host claude-code.*run preflight --host with --allow-trial/);
  desc.support = [{ role: 'B', runtime: 'opencode', transport: 'cli', status: 'trial' }];
  desc.seatA.transport = 'native';
  desc.seatB.transport = 'native';
  await fs.writeFile(file, JSON.stringify(desc));
  await assert.rejects(readRunDescriptor(h.run), /is unsupported on host claude-code|native opencode agent/);
});

test('F14: a native actor on a runtime the host cannot start natively is refused before run.json: an OpenAI seat on Claude Code, a Claude seat on Codex [slow]', async (t) => {
  const h = await harness(t);
  const nativeCodex = path.join(h.dir, 'native-codex.json');
  await fs.writeFile(nativeCodex, JSON.stringify({ ...h.seats, auditor: { ...h.seats.auditor, provider: 'openai', runtime: 'codex', model: 'gpt-5.5', transport: 'native' } }));
  const onClaudeCode = h.launch([], { seatsPath: nativeCodex });
  assert.equal(onClaudeCode.status, 1);
  assert.match(onClaudeCode.stderr, /native codex agent, but host claude-code can only start native claude agents; use transport cli/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  const onCodex = h.launch(['--host', 'codex']);
  assert.equal(onCodex.status, 1);
  assert.match(onCodex.stderr, /native claude agent, but host codex can only start native codex agents/);
});

test('F9/F10: an auditor or verifier with an empty model or an unsupported provider/runtime pair is refused, and verifier runtimes need their dispatcher [slow]', async (t) => {
  const h = await harness(t);
  const write = async (name, patch) => {
    const file = path.join(h.dir, name);
    await fs.writeFile(file, JSON.stringify({ ...h.seats, ...patch }));
    return file;
  };
  const emptyModel = h.launch([], { seatsPath: await write('a.json', { auditor: { ...h.seats.auditor, model: '' } }) });
  assert.equal(emptyModel.status, 1);
  assert.match(emptyModel.stderr, /actor "auditor" needs a non-empty string "model"/);
  const mismatch = h.launch([], { seatsPath: await write('b.json', { auditor: { ...h.seats.auditor, provider: 'openai' } }) });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /actor "auditor" runs provider "openai" on runtime "claude", which is not a supported pair/);
  const verifier = { role: 'verifier-1', provider: 'anthropic', runtime: 'claude', model: 'opus', transport: 'cli' };
  const badVerifier = h.launch([], { seatsPath: await write('c.json', { verifiers: [{ ...verifier, provider: 'mystery' }] }) });
  assert.equal(badVerifier.status, 1);
  assert.match(badVerifier.stderr, /actor "verifiers.0." runs provider "mystery"/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier dispatchers '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'claude-dispatch.mjs'), '');
  assert.deepEqual(missingDispatchers({ seatA: { runtime: 'claude' }, seatB: { runtime: 'claude' }, auditor: { runtime: 'claude' }, verifiers: [{ runtime: 'codex' }] }, dir), ['codex-dispatch.mjs']);
});

test('a Claude CLI seat on a Codex host needs a session probe: refused without it, run (paid) with it, refused when the session cannot be resumed [slow]', async (t) => {
  const h = await harness(t);
  const claudeCli = (role) => ({ provider: 'anthropic', runtime: 'claude', model: 'haiku', transport: 'cli', role });
  const codexNative = (role, model) => ({ provider: 'openai', runtime: 'codex', model, transport: 'native', role });
  const seatsFile = path.join(h.dir, 'cross-codex-host.json');
  const seatB = SKILL === 'pair-review' ? { ...claudeCli('B'), model: 'sonnet' } : codexNative('B', 'gpt-5.6-luna');
  await fs.writeFile(seatsFile, JSON.stringify({ seatA: claudeCli('A'), seatB, auditor: claudeCli('auditor') }));
  const noProbe = h.launch(['--host', 'codex', '--allow-trial'], { seatsPath: seatsFile });
  assert.equal(noProbe.status, 1);
  assert.match(noProbe.stderr, /actor "A" .claude, cli.: whether a Claude CLI session survives a call depends on how Codex was launched/);
  assert.match(noProbe.stderr, /--probe-claude-session --yes-paid/);
  const onlyHelp = async () => (await h.calls()).every((call) => call === '-p --help');
  assert.ok(await onlyHelp(), 'nothing paid ran: only the free help check');
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  const noPay = h.launch(['--host', 'codex', '--allow-trial', '--probe-claude-session'], { seatsPath: seatsFile });
  assert.equal(noPay.status, 1);
  assert.match(noPay.stderr, /would make two small paid Claude Haiku calls.*Add --yes-paid/);
  assert.ok(await onlyHelp(), 'still nothing paid');
  await fs.writeFile(path.join(h.bin, 'no-persist.flag'), 'x');
  const lost = h.launch(['--host', 'codex', '--allow-trial', '--probe-claude-session', '--yes-paid'], { seatsPath: seatsFile });
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /a Claude CLI seat cannot be resumed from this launch path: [^]*No conversation found/);
  await assert.rejects(fs.access(path.join(h.run, 'run.json')));
  await fs.rm(path.join(h.bin, 'no-persist.flag'));
  const kept = h.launch(['--host', 'codex', '--allow-trial', '--probe-claude-session', '--yes-paid'], { seatsPath: seatsFile });
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(JSON.parse(kept.stdout).hostStatus, 'trial');
  const desc = await readRunDescriptor(h.run);
  const seatA = desc.support.find((row) => row.role === 'A');
  assert.deepEqual([seatA.status, seatA.probe.ok, typeof seatA.probe.sessionId], ['trial', true, 'string']);
  assert.equal(desc.support.find((row) => row.role === 'auditor').probe, undefined, 'a single-call auditor needs no probe');
  const file = path.join(h.run, 'run.json');
  const edited = JSON.parse(await fs.readFile(file, 'utf8'));
  edited.support = edited.support.map((row) => ({ role: row.role, runtime: row.runtime, transport: row.transport, status: row.status }));
  await fs.writeFile(file, JSON.stringify(edited));
  await assert.rejects(readRunDescriptor(h.run), /actor "A" .claude, cli. needs a session probe on host codex/);
  if (SKILL !== 'pair-review') return;
  const pairSeats = path.join(h.dir, 'pair-codex-host.json');
  const second = await harness(t);
  await fs.writeFile(pairSeats, JSON.stringify({ seatA: codexNative('A', 'gpt-5.6-sol'), seatB: codexNative('B', 'gpt-5.6-terra'), auditor: claudeCli('auditor'), flags: { mode: 'collaborate' } }));
  const trial = second.launch(['--host', 'codex', '--allow-trial'], { seatsPath: pairSeats });
  assert.equal(trial.status, 0, trial.stderr);
  assert.deepEqual((await readRunDescriptor(second.run)).support.map((row) => [row.role, row.runtime, row.transport, row.status]), [['A', 'codex', 'native', 'trial'], ['B', 'codex', 'native', 'trial'], ['auditor', 'claude', 'cli', 'trial']]);
});

test('codexSandboxFailure: only a failed sandbox row counts', () => {
  assert.match(codexSandboxFailure('Notes\n   ⚠ security     2 issues\n   ✗ sandbox      elevated Windows sandbox provisioning recorded a structured failure\n'), /^✗ sandbox +elevated Windows sandbox/);
  assert.equal(codexSandboxFailure('   ✓ sandbox      ok\n   ✗ threads      state DB rows missing\n'), null);
  assert.equal(codexSandboxFailure(''), null);
});

test('host preflight: a Codex seat is refused when "codex doctor" shows a failed sandbox, and --skip-codex-doctor bypasses it [slow]', async (t) => {
  const h = await harness(t, CODEX_SEATS);
  const script = path.join(h.bin, 'codex-doctor.mjs');
  await fs.writeFile(script, "process.stdout.write('   \\u2717 sandbox      elevated Windows sandbox provisioning recorded a structured failure\\n');\n");
  await fs.writeFile(path.join(h.bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const unpaid = h.launch();
  assert.notEqual(unpaid.status, 0, unpaid.stdout);
  assert.match(unpaid.stderr, /"codex doctor" reports a failed sandbox .* nothing was run\. Add --yes-paid to run it, or --skip-codex-doctor/);
  assert.equal((await h.calls()).some((l) => l.startsWith('exec ')), false, 'no paid exec ran without --yes-paid');
  const refused = h.launch(['--yes-paid']);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stderr, /refused: "codex doctor" reports a failed sandbox/);
  assert.equal(await fs.access(path.join(h.run, 'run.json')).then(() => true, () => false), false, 'no run.json is written');
  const skipped = h.launch(['--skip-codex-doctor']);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(JSON.parse(skipped.stdout).codexDoctor, 'skipped (--skip-codex-doctor)');
});

test('host preflight: a failed doctor sandbox row is not a refusal when a live read-only probe runs a command', async (t) => {
  const h = await harness(t, CODEX_SEATS);
  const script = path.join(h.bin, 'codex-fake.mjs');
  const body = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const argv = process.argv.slice(2);",
    "if (argv[0] === 'doctor') { process.stdout.write('   \\u2717 sandbox      elevated Windows sandbox provisioning recorded a structured failure\\n'); process.exit(0); }",
    "if (argv[0] === 'exec') process.stdout.write(fs.readFileSync(path.join(argv[argv.indexOf('-C') + 1], 'codex-probe.txt'), 'utf8'));",
    '',
  ].join(String.fromCharCode(10));
  await fs.writeFile(script, body);
  await fs.writeFile(path.join(h.bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const confirmed = h.launch(['--yes-paid']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(JSON.parse(confirmed.stdout).codexDoctor, /live read-only probe ran a command/);
});

test('host preflight: a probe that passes after exec_command failures is reported as unstable with a warning, not refused [slow]', async (t) => {
  const h = await harness(t, CODEX_SEATS);
  const script = path.join(h.bin, 'codex-fake.mjs');
  const body = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const argv = process.argv.slice(2);",
    "if (argv[0] === 'doctor') { process.stdout.write('   \\u2717 sandbox      elevated Windows sandbox provisioning recorded a structured failure\\n'); process.exit(0); }",
    "if (argv[0] === 'exec') {",
    "  process.stderr.write('ERROR exec_command failed: setup refresh had errors\\nERROR exec_command failed: setup refresh had errors\\n');",
    "  process.stdout.write(fs.readFileSync(path.join(argv[argv.indexOf('-C') + 1], 'codex-probe.txt'), 'utf8'));",
    '}',
    '',
  ].join(String.fromCharCode(10));
  await fs.writeFile(script, body);
  await fs.writeFile(path.join(h.bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const r = h.launch(['--yes-paid']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).codexDoctor, /^unstable .*2 exec_command failure/);
  assert.match(r.stderr, /WARNING: the Codex sandbox is intermittent \(2 exec_command failure/);
});

test('host preflight: a missing task-packet.md in the run folder is a warning, not a refusal, and a present one is silent [slow]', async (t) => {
  const missing = await harness(t);
  const first = missing.launch();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /WARNING: .*task-packet\.md not found; run\.json is written, so write the packet there before "review-run phase1 --start" \(no need to rerun this command\)/);
  const present = await harness(t);
  await fs.mkdir(present.run, { recursive: true });
  await fs.writeFile(path.join(present.run, 'task-packet.md'), '# packet\n');
  const second = present.launch();
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /task-packet\.md not found/);
});

async function codexShim(h, body) {
  const script = path.join(h.bin, 'codex-fake.mjs');
  await fs.writeFile(script, body.join(String.fromCharCode(10)) + String.fromCharCode(10));
  await fs.writeFile(path.join(h.bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
}

test('host preflight: a codex doctor that exits non-zero or prints nothing is reported as skipped, never as a healthy sandbox [slow]', async (t) => {
  const failing = await harness(t, CODEX_SEATS);
  await codexShim(failing, ["process.stderr.write('unrecognized subcommand doctor\\n');", 'process.exit(2);']);
  const a = failing.launch();
  assert.equal(a.status, 0, a.stderr);
  assert.match(JSON.parse(a.stdout).codexDoctor, /^skipped \("codex doctor" exited 2: unrecognized subcommand doctor\)$/);
  const silent = await harness(t, CODEX_SEATS);
  await codexShim(silent, ['process.exit(0);']);
  const b = silent.launch();
  assert.equal(b.status, 0, b.stderr);
  assert.match(JSON.parse(b.stdout).codexDoctor, /^skipped \("codex doctor" printed nothing\)$/);
});

// The real "codex doctor --summary --no-color" output (codex-cli 0.162.1, Windows) that exits 1, local paths removed.
const DOCTOR_FAILED = fileURLToPath(new URL('./fixtures/codex-doctor/sandbox-failed-summary.txt', import.meta.url));

test('host preflight: the real doctor output with a failed sandbox row and exit 1 is a failure, not "skipped"; the live probe still overrides it [slow]', async (t) => {
  const doctor = `if (argv[0] === 'doctor') { process.stdout.write(fs.readFileSync(${JSON.stringify(DOCTOR_FAILED)}, 'utf8')); process.exit(1); }`;
  const failed = await harness(t, CODEX_SEATS);
  await codexShim(failed, ["import fs from 'node:fs';", 'const argv = process.argv.slice(2);', doctor]);
  const unpaid = failed.launch();
  assert.notEqual(unpaid.status, 0, unpaid.stdout);
  assert.match(unpaid.stderr, /"codex doctor" reports a failed sandbox \(. sandbox +elevated Windows sandbox provisioning recorded a structured failure\)[^]*Add --yes-paid to run it, or --skip-codex-doctor/);
  await assert.rejects(fs.access(path.join(failed.run, 'run.json')));
  const probed = await harness(t, CODEX_SEATS);
  await codexShim(probed, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const argv = process.argv.slice(2);',
    doctor,
    "if (argv[0] === 'exec') process.stdout.write(fs.readFileSync(path.join(argv[argv.indexOf('-C') + 1], 'codex-probe.txt'), 'utf8'));",
  ]);
  const confirmed = probed.launch(['--yes-paid']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(JSON.parse(confirmed.stdout).codexDoctor, /live read-only probe ran a command/);
});

const gitInit = (dir) => {
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '-m', 'one']]) {
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).status, 0);
  }
};
const IN_REPO = /is inside the git repository that holds --cd and is not git-ignored[^]*outside the repository, or in a folder the repository ignores/;

test('host preflight: with a Claude CLI seat, a run folder inside the target\'s repository and not ignored is refused before any call [slow]', async (t) => {
  // Run folder beside the target in one repository.
  const beside = await harness(t);
  gitInit(beside.dir);
  const a = beside.launch();
  assert.equal(a.status, 1, a.stdout);
  assert.match(a.stderr, IN_REPO);
  assert.deepEqual(await beside.calls(), [], 'refused before the Claude help check and any paid probe');
  await assert.rejects(fs.access(path.join(beside.run, 'run.json')));
  // Run folder inside the target, the target a subfolder of the repository.
  const inside = await harness(t);
  gitInit(inside.dir);
  const b = inside.launch([], { runDir: path.join(inside.target, 'run') });
  assert.equal(b.status, 1, b.stdout);
  assert.match(b.stderr, IN_REPO);
  // The target is the repository root and the run folder sits in it.
  const root = await harness(t);
  gitInit(root.target);
  const d = root.launch([], { runDir: path.join(root.target, 'reviews', 'run1') });
  assert.equal(d.status, 1, d.stdout);
  assert.match(d.stderr, IN_REPO);
});

test('host preflight: a run folder outside the repository, in an ignored folder, or with only native and Codex seats is accepted [slow]', async (t) => {
  // Outside: only the target is a repository.
  const outside = await harness(t);
  gitInit(outside.target);
  const c = outside.launch();
  assert.equal(c.status, 0, c.stderr);
  // Inside the repository, under a folder its .gitignore lists (the audit-input folder sits beside the run folder there too).
  const ignored = await harness(t);
  gitInit(ignored.dir);
  await fs.writeFile(path.join(ignored.dir, '.gitignore'), 'reviews/' + String.fromCharCode(10));
  const runDir = path.join(ignored.dir, 'reviews', 'run1');
  const a2 = ignored.launch([], { runDir });
  assert.equal(a2.status, 0, a2.stderr);
  assert.equal((await readRunDescriptor(runDir)).auditor.outputDir, `${runDir}-audit-input`);
  // Beside the target in one repository, but no actor builds a worktree.
  const nativeSeats = await harness(t, { seatA: { transport: 'native' }, seatB: SKILL === 'pair-review' ? { model: 'sonnet', transport: 'native' } : CROSS_SEAT_B });
  gitInit(nativeSeats.dir);
  const n = nativeSeats.launch();
  assert.equal(n.status, 0, n.stderr);
});

test('host preflight: an unsupported route is refused before any paid probe runs', async (t) => {
  const h = await harness(t, CODEX_SEATS);
  await codexShim(h, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    "fs.appendFileSync(path.join(here, 'codex-calls.log'), process.argv.slice(2).join(' ') + '\\n');",
    "if (process.argv[2] === 'doctor') process.stdout.write('   \\u2717 sandbox      failed\\n');",
  ]);
  const r = h.launch(['--host', 'codex', '--yes-paid']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /refused: actor/);
  const log = await fs.readFile(path.join(h.bin, 'codex-calls.log'), 'utf8');
  assert.match(log, /^doctor/m, 'the free doctor check ran');
  assert.doesNotMatch(log, /^exec/m, 'the support table refused the run before the paid probe');
});

test('host preflight: --exec and --exec-in are refused with --host instead of being ignored', async (t) => {
  const h = await harness(t);
  const r = h.launch(['--exec-in', h.target, 'echo hi']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--exec and --exec-in are not used with --host/);
});

test('--host --repo records each extra repository and its snapshotHash in run.json, never the target itself [slow]', async (t) => {
  const h = await harness(t);
  const extra = path.join(h.dir, 'extra');
  await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, 'lib.txt'), 'library\n');
  // On Windows the target written in another case ("c:\..." for "C:\...") is still the target.
  const r = h.launch(['--repo', extra, '--repo', h.target, ...(process.platform === 'win32' ? ['--repo', h.target.toLowerCase()] : [])]);
  assert.equal(r.status, 0, r.stderr);
  const desc = await readRunDescriptor(h.run);
  assert.equal(desc.extraRepos.length, 1);
  assert.equal(desc.extraRepos[0].dir, path.resolve(extra));
  assert.match(desc.extraRepos[0].snapshotHash, /^[0-9a-f]{64}$/);
});

test('host preflight: a repository whose .gitignore has CRLF line endings and a blank line (git then reports every folder path ignored) still refuses a run folder inside it, and still accepts an ignored one [slow]', async (t) => {
  const crlf = String.fromCharCode(13, 10);
  const refused = await harness(t);
  gitInit(refused.dir);
  await fs.writeFile(path.join(refused.dir, '.gitignore'), ['node_modules/', '', 'dist/', ''].join(crlf));
  const a = refused.launch();
  assert.equal(a.status, 1, a.stdout);
  assert.match(a.stderr, IN_REPO);
  const accepted = await harness(t);
  gitInit(accepted.dir);
  await fs.writeFile(path.join(accepted.dir, '.gitignore'), ['reviews/', '', 'dist/', ''].join(crlf));
  const runDir = path.join(accepted.dir, 'reviews', 'run1');
  const b = accepted.launch([], { runDir });
  assert.equal(b.status, 0, b.stderr);
});
