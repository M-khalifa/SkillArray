import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, readConfig, writeConfig, resolveConfig, parseOptions, buildSeats } from '../review-config.mjs';
import { isSupportedPair } from '../provider-catalog.mjs';

test('first setup requires two distinct pair models', () => {
  assert.throws(() => resolveConfig(null, 'pair-review', { a: 'opus' }), /Invalid reviewer B/);
  assert.throws(() => resolveConfig(null, 'pair-review', { a: 'opus', b: 'opus' }), /distinct/);
  const c = resolveConfig(null, 'pair-review', { a: 'opus', b: 'sonnet' });
  assert.equal(c.reviewers.B.effort, 'default');
  assert.equal(c.mode, 'collaborate');
});

test('pair-review takes two distinct models from one vendor: anthropic/claude or openai/codex, never mixed', () => {
  const openai = { 'a-provider': 'openai', 'b-provider': 'openai', a: 'gpt-5.6-sol', b: 'gpt-5.6-terra' };
  const c = resolveConfig(null, 'pair-review', openai);
  assert.deepEqual([c.reviewers.A.runtime, c.reviewers.B.runtime], ['codex', 'codex']);
  assert.deepEqual([c.reviewers.A.model, c.reviewers.B.model], ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.throws(() => resolveConfig(null, 'pair-review', { ...openai, b: 'gpt-5.6-sol' }), /distinct/);
  assert.throws(() => resolveConfig(null, 'pair-review', { 'b-provider': 'openai', a: 'opus', b: 'gpt-5.6-sol' }), /one vendor/);
  assert.throws(() => resolveConfig(null, 'pair-review', { 'a-provider': 'openai', 'b-provider': 'openai', 'a-runtime': 'opencode', a: 'openai/x', b: 'gpt-5.6-sol' }), /Invalid reviewer A/);
});

test('cross-review accepts selectable providers and requires adversarial mode', () => {
  const c = resolveConfig(null, 'cross-review', {
    a: 'fable', 'a-provider': 'anthropic', 'a-runtime': 'claude',
    b: 'gpt-5.6-sol', 'b-provider': 'openai', 'b-runtime': 'codex',
  });
  assert.equal(c.reviewers.A.provider, 'anthropic');
  assert.equal(c.reviewers.B.provider, 'openai');
  assert.equal(c.reviewers.B.runtime, 'codex');
  assert.throws(() => resolveConfig(c, 'cross-review', { mode: 'none' }), /mode/);
  assert.throws(() => resolveConfig(c, 'cross-review', { 'b-provider': 'openai', 'b-runtime': 'opencode', b: 'openai/x' }), /Invalid reviewer B/);
  assert.throws(() => resolveConfig(c, 'cross-review', { 'b-provider': 'google', b: 'google/example-model' }), /Invalid reviewer B/);
});

test('one-run overrides leave saved settings intact and clear stale effort', () => {
  const saved = resolveConfig(null, 'pair-review', { a: 'opus', b: 'sonnet', 'b-effort': 'high' });
  const changed = resolveConfig(saved, 'pair-review', { b: 'haiku' });
  assert.equal(changed.reviewers.B.effort, 'default');
  assert.equal(saved.reviewers.B.model, 'sonnet');
  assert.equal(saved.reviewers.B.effort, 'high');
  assert.equal(resolveConfig(saved, 'pair-review', { b: 'haiku', 'b-effort': 'low' }).reviewers.B.effort, 'low');
  assert.equal(resolveConfig(saved, 'pair-review', { b: 'sonnet' }).reviewers.B.effort, 'high');
});

test('storage precedence is portable and skill files are independent', () => {
  const home = path.resolve('test-home');
  const override = path.resolve('override');
  const xdg = path.resolve('xdg');
  assert.equal(configPath('pair-review', {}, home), path.join(home, '.config', 'review-skills', 'pair-review.json'));
  assert.equal(configPath('pair-review', { XDG_CONFIG_HOME: xdg }, home), path.join(xdg, 'review-skills', 'pair-review.json'));
  assert.equal(configPath('cross-review', { REVIEW_SKILLS_CONFIG_DIR: override, XDG_CONFIG_HOME: xdg }, home), path.join(override, 'cross-review.json'));
  assert.throws(() => configPath('pair-review', { REVIEW_SKILLS_CONFIG_DIR: 'relative' }, home), /absolute/);
});

test('missing differs from corrupt or unsupported config', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pair-review.json');
  assert.equal(await readConfig(file, 'pair-review'), null);
  await fs.writeFile(file, '{bad');
  await assert.rejects(readConfig(file, 'pair-review'), (err) => {
    assert.ok(err instanceof SyntaxError);
    assert.ok(err.message.includes(file));
    assert.match(err.message, /fix it or run reset/);
    return true;
  });
  await fs.writeFile(file, JSON.stringify({ version: 99 }));
  await assert.rejects(readConfig(file, 'pair-review'), /Unsupported/);
  // Pair review F2: a file saved with the removed OpenCode runtime names the file and says reset, then setup.
  await fs.writeFile(file, JSON.stringify({ version: 2, skill: 'pair-review', mode: 'collaborate', reviewers: {
    A: { provider: 'anthropic', runtime: 'claude', model: 'opus', effort: 'default' },
    B: { provider: 'openai', runtime: 'opencode', model: 'openai/gpt-5', effort: 'default' } } }));
  await assert.rejects(readConfig(file, 'pair-review'), (err) => {
    assert.ok(err.message.includes(file), err.message);
    assert.match(err.message, /holds saved choices this version cannot use \(.+\); run reset, then setup/);
    return true;
  });
});

test('atomic save round-trips changes without touching another skill', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'pair-review.json');
  const other = path.join(dir, 'cross-review.json');
  await fs.writeFile(other, 'untouched');
  const first = resolveConfig(null, 'pair-review', { a: 'opus', b: 'sonnet' });
  await writeConfig(file, first);
  const next = resolveConfig(await readConfig(file, 'pair-review'), 'pair-review', { b: 'haiku' });
  await writeConfig(file, next);
  assert.deepEqual(await readConfig(file, 'pair-review'), next);
  assert.equal(await fs.readFile(other, 'utf8'), 'untouched');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['pair-review.json']);
});

test('invalid flags, blank values, and implicit inherited model fail', () => {
  for (const argv of [['setup', '--a'], ['setup', '--a', ''], ['show', '--b', 'x'],
    ['setup', '--unknown', 'x'], ['setup', '--a', 'x', '--a', 'y']]) {
    assert.throws(() => parseOptions(argv));
  }
  assert.throws(() => resolveConfig(null, 'pair-review', { a: 'inherit', b: 'sonnet' }));
  assert.throws(() => resolveConfig(null, 'pair-review', { a: 'opus & command', b: 'sonnet' }));
  assert.throws(() => resolveConfig(null, 'cross-review', {
    a: 'fable', b: 'other', 'b-provider': 'openai', 'b-runtime': 'claude',
  }), /Invalid reviewer B/);
});

test('version 1 saved preferences migrate to version 2 with a runtime', () => {
  const legacy = {
    version: 1, skill: 'cross-review', mode: 'adversarial', reviewers: {
      A: { provider: 'anthropic', model: 'fable', effort: 'default' },
      B: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' },
    },
  };
  const migrated = resolveConfig(legacy, 'cross-review');
  assert.equal(migrated.version, 2);
  assert.equal(migrated.reviewers.A.runtime, 'claude');
  assert.equal(migrated.reviewers.B.runtime, 'codex');
});

test('CLI setup, resolve, reconfigure, show, reset preserve per-skill isolation [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../review-config.mjs', import.meta.url));
  const skill = path.basename(path.dirname(path.dirname(script)));
  const other = path.join(dir, 'other-skill.json');
  await fs.writeFile(other, 'untouched');
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, REVIEW_SKILLS_CONFIG_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(invoke('show').configured, false);
  invoke('setup', '--a', 'opus', '--b', 'test-model-b', '--b-effort', 'high');
  assert.equal(invoke('resolve', '--b', 'other-model').config.reviewers.B.effort, 'default');
  assert.equal(invoke('show').config.reviewers.B.model, 'test-model-b');
  invoke('setup', '--b', 'replacement');
  assert.equal(invoke('show').config.reviewers.B.model, 'replacement');
  invoke('reset');
  assert.equal(invoke('show').configured, false);
  assert.equal(await fs.readFile(other, 'utf8'), 'untouched');
  await assert.rejects(fs.stat(path.join(dir, skill + '.json')), { code: 'ENOENT' });
});

test('writeConfig rejects an undispatchable cross-review seat layout and writes nothing to disk', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config-reject-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cross-review.json');
  const bad = {
    version: 2, skill: 'cross-review', mode: 'adversarial',
    reviewers: {
      A: { provider: 'openai', runtime: 'codex', model: 'gpt-6-astra', effort: 'default' },
      B: { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-sol', effort: 'default' },
    },
  };
  await assert.rejects(() => writeConfig(file, bad), /seat A to run on the Claude harness/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('cross review rejects seat B on the claude runtime and seat A on anything but the claude harness', () => {
  assert.throws(() => resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'anthropic', 'b-runtime': 'claude', b: 'sonnet',
  }), /seat B to run through codex-dispatch/);
  assert.throws(() => resolveConfig(null, 'cross-review', {
    'a-provider': 'openai', 'a-runtime': 'codex', a: 'gpt-6-astra',
    'b-provider': 'openai', b: 'gpt-5.6-sol',
  }), /seat A to run on the Claude harness/);
});

test('a garbage-shaped or prototype-chain provider name is rejected and never crashes', () => {
  for (const bad of ['x/y:z', '../../etc/passwd', 'Google', '', 'a b', 'groq']) {
    assert.throws(() => resolveConfig(null, 'cross-review', {
      'a-provider': bad, 'a-runtime': 'claude', a: 'm', 'b-provider': 'openai', b: 'gpt-6-astra',
    }), /Invalid reviewer A/, `expected "${bad}" to be rejected`);
  }
  for (const proto of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(isSupportedPair(proto, 'codex'), false);
    assert.throws(() => resolveConfig(null, 'cross-review', {
      'a-provider': proto, 'a-runtime': 'claude', a: 'm', 'b-provider': 'openai', b: 'gpt-6-astra',
    }), /Invalid reviewer A/, `expected "${proto}" under claude runtime to be rejected, not crash`);
  }
});

test('isSupportedPair truth table: the two catalog providers on their own runtime, nothing else', () => {
  assert.equal(isSupportedPair('anthropic', 'claude'), true);
  assert.equal(isSupportedPair('openai', 'codex'), true);
  assert.equal(isSupportedPair('anthropic', 'codex'), false);
  for (const provider of ['openai', 'anthropic', 'google', 'groq']) assert.equal(isSupportedPair(provider, 'opencode'), false, provider);
  assert.equal(isSupportedPair('groq', 'claude'), false);
  assert.equal(isSupportedPair('constructor', 'claude'), false);
  assert.equal(isSupportedPair('toString', 'claude'), false);
  assert.equal(isSupportedPair(123, 'claude'), false);
  assert.equal(isSupportedPair('anthropic', null), false);
});

test('catalog command exposes current OpenAI tiers and Fable', () => {
  const script = fileURLToPath(new URL('../review-config.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'catalog'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.providers.openai.models.map((model) => model.id), [
    'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-5.5',
  ]);
  assert.ok(value.providers.anthropic.models.some((model) => model.id === 'fable'));
});

test('seats: the seats file is built from the resolved choices, native for the host runtime and CLI for the rest', () => {
  const cross = resolveConfig(null, 'cross-review', { a: 'opus', b: 'gpt-5.6-terra', 'b-provider': 'openai', 'b-runtime': 'codex', 'b-effort': 'high' });
  const onClaudeCode = buildSeats(cross, 'claude-code');
  assert.deepEqual(onClaudeCode.seatA, { provider: 'anthropic', runtime: 'claude', model: 'opus', effort: null, transport: 'native' });
  assert.deepEqual(onClaudeCode.seatB, { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-terra', effort: 'high', transport: 'cli' });
  assert.deepEqual(onClaudeCode.auditor, onClaudeCode.seatA, 'the auditor repeats seat A');
  assert.deepEqual(onClaudeCode.flags, { falsification: false, mode: 'adversarial', repoOnly: false });
  assert.equal(buildSeats(cross, 'claude-code', { transport: 'cli' }).seatA.transport, 'cli');
  assert.equal(buildSeats(cross, 'claude-code', { transport: 'cli' }).seatB.transport, 'cli');
  const onCodex = buildSeats(cross, 'codex');
  assert.equal(onCodex.seatA.transport, 'cli', 'a Claude actor runs through its CLI on a Codex host');
  assert.equal(onCodex.seatB.transport, 'native');
  const pair = resolveConfig(null, 'pair-review', { a: 'gpt-5.6-sol', b: 'gpt-5.6-terra', 'a-provider': 'openai', 'b-provider': 'openai' });
  assert.deepEqual(['seatA', 'seatB', 'auditor'].map((role) => buildSeats(pair, 'claude-code')[role].transport), ['cli', 'cli', 'cli']);
  assert.deepEqual(['seatA', 'seatB', 'auditor'].map((role) => buildSeats(pair, 'codex')[role].transport), ['native', 'native', 'native']);
  assert.equal(buildSeats(pair, 'codex').flags.mode, 'collaborate');
  assert.throws(() => buildSeats(pair, 'gemini'), /--host must be claude-code or codex/);
  assert.throws(() => buildSeats(pair, 'codex', { transport: 'foreground' }), /--transport must be native or cli/);
});

test('Linux round F9: seats warns when a Codex CLI seat runs on the default effort, and not with an effort set', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seats-effort '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../review-config.mjs', import.meta.url));
  const env = { ...process.env, REVIEW_SKILLS_CONFIG_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  // pair-review needs one vendor (two Codex models); cross-review needs two.
  const pair = path.basename(path.resolve(path.dirname(script), '..')) === 'pair-review';
  const setup = pair
    ? ['setup', '--a-provider', 'openai', '--a-runtime', 'codex', '--a', 'gpt-5.6-terra', '--b-provider', 'openai', '--b-runtime', 'codex', '--b', 'gpt-6-sol']
    : ['setup', '--a', 'opus', '--b-provider', 'openai', '--b-runtime', 'codex', '--b', 'gpt-6-sol'];
  assert.equal(run(...setup).status, 0, run(...setup).stderr);
  const plain = run('seats', '--host', 'claude-code', '--transport', 'cli');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, /WARNING: seat B \(codex\) runs on Codex's default effort, which the rollout does not report; set one with --b-effort high/);
  const set = run('seats', '--host', 'claude-code', '--transport', 'cli', ...(pair ? ['--a-effort', 'high'] : []), '--b-effort', 'high');
  assert.equal(set.status, 0, set.stderr);
  assert.doesNotMatch(set.stderr, /default effort/);
  // Closing round 2: a native seat or auditor gets a one-line note about host-loaded instructions and memory; CLI ones do not.
  assert.doesNotMatch(plain.stderr, /native agent/);
  const native = run('seats', '--host', pair ? 'codex' : 'claude-code', '--b-effort', 'high');
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stderr, pair
    ? /note: seat A, seat B, the auditor run as native agents and also see the host's own instructions and memory .*--transport cli/
    : /note: seat A, the auditor run as native agents and also see the host's own instructions and memory .*--transport cli/);
});

test('seats CLI: --host is required, an output file is never overwritten, and the file passes the layout rules', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seats-cli '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../review-config.mjs', import.meta.url));
  const env = { ...process.env, REVIEW_SKILLS_CONFIG_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  assert.equal(run('setup', '--a', 'opus', '--b', 'sonnet').status, 0);
  const noHost = run('seats');
  assert.notEqual(noHost.status, 0);
  assert.match(noHost.stderr, /seats needs --host/);
  const out = path.join(dir, 'seats.json');
  const written = run('seats', '--host', 'claude-code', '--out', out);
  assert.equal(written.status, 0, written.stderr);
  const seats = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual([seats.seatA.model, seats.seatB.model, seats.auditor.model], ['opus', 'sonnet', 'opus']);
  const again = run('seats', '--host', 'claude-code', '--out', out);
  assert.notEqual(again.status, 0, 'an existing file is not overwritten');
  assert.match(again.stderr, /already exists: choose a new --out path, or add --replace to overwrite it/);
  // Field feedback S9: --replace overwrites on purpose (switching a seat's transport before preflight).
  const replaced = run('seats', '--host', 'claude-code', '--transport', 'cli', '--out', out, '--replace');
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).seatA.transport, 'cli', 'field feedback S9: the file was replaced');
  assert.equal(JSON.parse(run('seats', '--host', 'codex', '--transport', 'cli', '--b', 'haiku').stdout).seatB.model, 'haiku', 'one-run overrides apply');
  // The manifest's selection_source comes from here: saved choices are "saved", a one-run override is "explicit".
  assert.deepEqual([seats.seatA.selectionSource, seats.seatB.selectionSource], ['saved', 'saved']);
  const override = JSON.parse(run('seats', '--host', 'claude-code', '--b', 'haiku').stdout);
  assert.deepEqual([override.seatA.selectionSource, override.seatB.selectionSource], ['saved', 'explicit']);
  // An effort override alone keeps the saved model.
  const effortOnly = JSON.parse(run('seats', '--host', 'claude-code', '--b-effort', 'high').stdout);
  assert.equal(effortOnly.seatB.selectionSource, 'saved');
});

test('seats: --repo-only sets flags.repoOnly, and is false by default (field: the web choice must be readable from the file)', async () => {
  const cross = resolveConfig(null, 'cross-review', { a: 'opus', b: 'gpt-5.6-terra', 'b-provider': 'openai', 'b-runtime': 'codex', 'b-effort': 'high' });
  assert.equal(buildSeats(cross, 'claude-code').flags.repoOnly, false);
  assert.equal(buildSeats(cross, 'claude-code', { repoOnly: true }).flags.repoOnly, true);
  assert.deepEqual(parseOptions(['seats', '--host', 'claude-code', '--repo-only', '--transport', 'cli']).options, { host: 'claude-code', 'repo-only': true, transport: 'cli' });
  assert.deepEqual(parseOptions(['seats', '--repo-only', '--host', 'codex']).options, { 'repo-only': true, host: 'codex' });
  assert.throws(() => parseOptions(['seats', '--repo-only', '--repo-only']), /Duplicate option: --repo-only/);
  assert.throws(() => parseOptions(['resolve', '--repo-only']), /Unknown option: --repo-only/);
});

test('seats: there is no audit depth to choose (every audit is full), --mode sets the mode, --help lists them', () => {
  const cross = resolveConfig(null, 'cross-review', { a: 'opus', b: 'gpt-5.6-terra', 'b-provider': 'openai', 'b-runtime': 'codex', 'b-effort': 'high' });
  assert.equal(Object.hasOwn(buildSeats(cross, 'claude-code').flags, 'auditDepth'), false);
  assert.throws(() => parseOptions(['seats', '--host', 'claude-code', '--audit-depth', 'full']), /Unknown option: --audit-depth/);
  assert.deepEqual(parseOptions(['seats', '--host', 'claude-code', '--mode', 'adversarial']).options, { host: 'claude-code', mode: 'adversarial' });
  assert.equal(parseOptions(['seats', '--help']).command, '--help');
  assert.equal(parseOptions(['seats', '--host', 'codex', '-h']).command, '--help');
});

test('seats: --falsification turns the verification pass on in the seats file', () => {
  const cross = resolveConfig(null, 'cross-review', { a: 'opus', b: 'gpt-5.6-terra', 'b-provider': 'openai', 'b-runtime': 'codex', 'b-effort': 'high' });
  assert.equal(buildSeats(cross, 'claude-code').flags.falsification, false);
  assert.equal(buildSeats(cross, 'claude-code', { falsification: true }).flags.falsification, true);
  assert.deepEqual(parseOptions(['seats', '--host', 'claude-code', '--falsification', '--repo-only']).options, { host: 'claude-code', falsification: true, 'repo-only': true });
  assert.throws(() => parseOptions(['seats', '--falsification', '--falsification']), /Duplicate option: --falsification/);
  assert.throws(() => parseOptions(['resolve', '--falsification']), /Unknown option: --falsification/);
});

test('seats --auditor puts the auditor on another model of seat A\'s provider; without it the auditor repeats seat A', async () => {
  const { buildSeats, parseOptions } = await import('../review-config.mjs');
  const config = { mode: 'adversarial', reviewers: { A: { provider: 'anthropic', runtime: 'claude', model: 'opus', effort: 'default' }, B: { provider: 'openai', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'default' } } };
  const same = buildSeats(config, 'claude-code');
  assert.equal(same.auditor.model, 'opus');
  const other = buildSeats(config, 'claude-code', { auditorModel: 'sonnet', auditorEffort: 'high' });
  assert.deepEqual([other.auditor.provider, other.auditor.runtime, other.auditor.model, other.auditor.effort, other.auditor.transport], ['anthropic', 'claude', 'sonnet', 'high', 'native']);
  assert.equal(other.seatA.model, 'opus', 'seat A is unchanged');
  assert.equal(buildSeats(config, 'claude-code', { auditorModel: 'sonnet' }).auditor.effort, null);
  assert.throws(() => buildSeats(config, 'claude-code', { auditorEffort: 'high' }), /needs --auditor/);
  assert.throws(() => buildSeats(config, 'claude-code', { auditorModel: 'two words' }), /one model id/);
  assert.equal(parseOptions(['seats', '--host', 'claude-code', '--auditor', 'sonnet']).options.auditor, 'sonnet');
  assert.throws(() => parseOptions(['resolve', '--auditor', 'sonnet']), /Unknown option/);
});

test('seats --env, --env-mode and --use-api-key write a per-actor env setting of names only; the auditor takes seat A\'s', async () => {
  const { buildSeats, parseOptions, seatEnv } = await import('../review-config.mjs');
  const config = { mode: 'adversarial', reviewers: { A: { provider: 'anthropic', runtime: 'claude', model: 'opus', effort: 'default' }, B: { provider: 'openai', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'default' } } };
  const { options } = parseOptions(['seats', '--host', 'claude-code', '--env', 'A=CLAUDE_CODE_USE_BEDROCK, AWS_REGION', '--env-mode', 'B=inherit', '--use-api-key', 'A', '--env', 'B=OPENAI_BASE_URL']);
  assert.deepEqual(options.env, ['A=CLAUDE_CODE_USE_BEDROCK, AWS_REGION', 'B=OPENAI_BASE_URL']);
  const env = seatEnv(options);
  assert.deepEqual(env, { A: { pass: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION'], apiKey: true }, B: { pass: ['OPENAI_BASE_URL'], mode: 'inherit' } });
  const seats = buildSeats(config, 'claude-code', { transport: 'cli', env });
  assert.deepEqual(seats.seatA.env, { pass: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION'], apiKey: true });
  assert.deepEqual(seats.seatB.env, { pass: ['OPENAI_BASE_URL'], mode: 'inherit' });
  assert.deepEqual(seats.auditor.env, seats.seatA.env, 'the auditor runs on seat A\'s provider');
  assert.deepEqual(buildSeats(config, 'claude-code', { transport: 'cli', env: { ...env, auditor: { mode: 'inherit' } } }).auditor.env, { mode: 'inherit' });
  assert.equal(buildSeats(config, 'claude-code', { transport: 'cli' }).seatA.env, undefined);
  // A native seat runs in the host's environment, so the setting is refused for it; an inherited auditor setting is dropped.
  assert.throws(() => buildSeats(config, 'claude-code', { env }), /apply to a CLI actor only; A runs as a native agent/);
  assert.equal(buildSeats(config, 'claude-code', { env: { B: env.B } }).auditor.env, undefined);
  assert.throws(() => buildSeats(config, 'claude-code', { transport: 'cli', env: { B: { apiKey: true } } }), /--use-api-key B: ANTHROPIC_API_KEY is for a Claude CLI actor/);
  assert.throws(() => seatEnv({ env: ['A=AWS_SECRET_ACCESS_KEY=abc'] }), /not a variable name \(names only, never NAME=value\)/);
  assert.throws(() => seatEnv({ env: ['A=X', 'A=Y'] }), /--env given twice for A/);
  assert.throws(() => seatEnv({ env: ['C=X'] }), /takes a role first: A, B or auditor/);
  assert.throws(() => seatEnv({ 'env-mode': ['A=open'] }), /--env-mode takes ROLE=filtered or ROLE=inherit/);
  assert.throws(() => parseOptions(['resolve', '--env', 'A=X']), /Unknown option/);
});

test('checklists: a user\'s own bug checklists are listed and read from the config directory, names cannot leave it', async (t) => {
  const { checklistDir, listChecklists, readChecklist, parseOptions } = await import('../review-config.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checklists-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = checklistDir({ REVIEW_SKILLS_CONFIG_DIR: root }, root);
  assert.equal(dir, path.join(root, 'checklists'));
  assert.deepEqual(await listChecklists(dir), [], 'no folder yet is an empty list');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'collector.md'), '# my list\r\n- paging: an offset that replays rows\r\n* ACL-empty page is not the end\r\ntext that is not an item\r\n- TLS and credentials on a fallback\r\n');
  await fs.writeFile(path.join(dir, 'notes.txt'), '- ignored: not a .md file\n');
  assert.deepEqual(await listChecklists(dir), [{ name: 'collector', items: 3 }]);
  assert.deepEqual((await readChecklist(dir, 'collector')).items, ['paging: an offset that replays rows', 'ACL-empty page is not the end', 'TLS and credentials on a fallback']);
  await assert.rejects(readChecklist(dir, '../config'), /A checklist name/);
  await assert.rejects(readChecklist(dir, 'missing'), /No checklist "missing"/);
  assert.equal(parseOptions(['checklists', '--name', 'collector']).options.name, 'collector');
  assert.throws(() => parseOptions(['show', '--name', 'x']), /takes no options|Unknown option/);
});
