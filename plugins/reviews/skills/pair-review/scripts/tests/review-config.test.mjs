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
  assert.throws(() => resolveConfig(null, 'pair-review', { 'a-provider': 'openai', 'b-provider': 'openai', 'a-runtime': 'opencode', a: 'openai/x', b: 'gpt-5.6-sol' }), /one vendor/);
  assert.throws(() => resolveConfig(null, 'pair-review', { 'a-provider': 'google', 'a-runtime': 'opencode', 'b-provider': 'google', 'b-runtime': 'opencode', a: 'google/x', b: 'google/y' }), /one vendor/);
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
  assert.throws(() => resolveConfig(c, 'cross-review', {
    'b-provider': 'anthropic', 'b-runtime': 'opencode', b: 'anthropic/fable',
  }), /different providers/);
  const google = resolveConfig(c, 'cross-review', {
    'b-provider': 'google', 'b-runtime': 'opencode', b: 'google/example-model',
  });
  assert.equal(google.reviewers.B.provider, 'google');
  assert.equal(google.reviewers.B.runtime, 'opencode');
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

test('an OpenCode seat whose model ID does not start with its declared provider is rejected, never silently dispatched to a different vendor', () => {
  // B5 repro: provider "google" alongside a model ID that actually routes to Anthropic
  // would defeat cross-vendor validation (A.provider !== B.provider looks satisfied).
  assert.throws(() => resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'google', 'b-runtime': 'opencode', b: 'anthropic/claude-opus-5',
  }), /does not start with "google\//);
  // Same provider label but the model ID disagrees with it -- also rejected.
  assert.throws(() => resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'anthropic', 'b-runtime': 'opencode', b: 'openai/gpt-6-astra',
  }), /does not start with "anthropic\//);
  // A bare model with no "/" at all under opencode is rejected, not treated as unprefixed-ok.
  assert.throws(() => resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'google', 'b-runtime': 'opencode', b: 'gemini-3-pro',
  }), /does not start with "google\//);
  // Provider/model agreeing (case-insensitively) is accepted.
  const ok = resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'google', 'b-runtime': 'opencode', b: 'Google/gemini-3-pro',
  });
  assert.equal(ok.reviewers.B.model, 'Google/gemini-3-pro');
});

test('an uncatalogued but well-formed provider is accepted only under the opencode runtime, and only for seat B', () => {
  const c = resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'groq', 'b-runtime': 'opencode', b: 'groq/llama',
  });
  assert.equal(c.reviewers.B.provider, 'groq');
  const noRuntime = resolveConfig(null, 'cross-review', { a: 'opus', 'b-provider': 'groq', b: 'groq/llama' });
  assert.equal(noRuntime.reviewers.B.runtime, 'opencode');
  assert.throws(() => resolveConfig(null, 'cross-review', {
    a: 'opus', 'b-provider': 'groq', 'b-runtime': 'claude', b: 'groq/llama',
  }), /Invalid reviewer B/);
  // Seat A has no dispatcher script; only the Claude harness can run it.
  assert.throws(() => resolveConfig(null, 'cross-review', {
    'a-provider': 'groq', 'a-runtime': 'opencode', a: 'groq/llama',
    'b-provider': 'openai', b: 'gpt-6-astra',
  }), /seat A to run on the Claude harness/);
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

test('a garbage-shaped or prototype-chain provider name is rejected even under the opencode runtime, and never crashes', () => {
  for (const bad of ['x/y:z', '../../etc/passwd', 'Google', '', 'a b']) {
    assert.throws(() => resolveConfig(null, 'cross-review', {
      'a-provider': bad, 'a-runtime': 'opencode', a: 'm', 'b-provider': 'openai', b: 'gpt-6-astra',
    }), /Invalid reviewer A/, `expected "${bad}" to be rejected`);
  }
  for (const proto of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.doesNotThrow(() => isSupportedPair(proto, 'opencode'));
    assert.throws(() => resolveConfig(null, 'cross-review', {
      'a-provider': proto, 'a-runtime': 'claude', a: 'm', 'b-provider': 'openai', b: 'gpt-6-astra',
    }), /Invalid reviewer A/, `expected "${proto}" under claude runtime to be rejected, not crash`);
  }
});

test('isSupportedPair truth table: catalog providers, the opencode bounded hatch, and prototype-chain keys', () => {
  assert.equal(isSupportedPair('anthropic', 'claude'), true);
  assert.equal(isSupportedPair('openai', 'codex'), true);
  assert.equal(isSupportedPair('google', 'opencode'), true);
  assert.equal(isSupportedPair('opencode', 'opencode'), true);
  assert.equal(isSupportedPair('anthropic', 'codex'), false);
  assert.equal(isSupportedPair('groq', 'opencode'), true);
  assert.equal(isSupportedPair('groq', 'claude'), false);
  assert.equal(isSupportedPair('x/y:z', 'opencode'), false);
  assert.equal(isSupportedPair('constructor', 'opencode'), true);
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
    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
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
  assert.deepEqual(onClaudeCode.flags, { auditDepth: 'light', falsification: false, mode: 'adversarial' });
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
  assert.match(again.stderr, /already exists and is never overwritten: choose a new --out path/);
  assert.equal(JSON.parse(run('seats', '--host', 'codex', '--transport', 'cli', '--b', 'haiku').stdout).seatB.model, 'haiku', 'one-run overrides apply');
});

test('seats: --repo-only sets flags.repoOnly, and is absent by default', async () => {
  const cross = resolveConfig(null, 'cross-review', { a: 'opus', b: 'gpt-5.6-terra', 'b-provider': 'openai', 'b-runtime': 'codex', 'b-effort': 'high' });
  assert.equal('repoOnly' in buildSeats(cross, 'claude-code').flags, false);
  assert.equal(buildSeats(cross, 'claude-code', { repoOnly: true }).flags.repoOnly, true);
  assert.deepEqual(parseOptions(['seats', '--host', 'claude-code', '--repo-only', '--transport', 'cli']).options, { host: 'claude-code', 'repo-only': true, transport: 'cli' });
  assert.deepEqual(parseOptions(['seats', '--repo-only', '--host', 'codex']).options, { 'repo-only': true, host: 'codex' });
  assert.throws(() => parseOptions(['seats', '--repo-only', '--repo-only']), /Duplicate option: --repo-only/);
  assert.throws(() => parseOptions(['resolve', '--repo-only']), /Unknown option: --repo-only/);
});

test('seats: --audit-depth sets flags.auditDepth, --mode sets the mode, --help lists them', () => {
  const cross = resolveConfig(null, 'cross-review', { a: 'opus', b: 'gpt-5.6-terra', 'b-provider': 'openai', 'b-runtime': 'codex', 'b-effort': 'high' });
  assert.equal(buildSeats(cross, 'claude-code').flags.auditDepth, 'light');
  assert.equal(buildSeats(cross, 'claude-code', { auditDepth: 'full' }).flags.auditDepth, 'full');
  assert.throws(() => buildSeats(cross, 'claude-code', { auditDepth: 'deep' }), /--audit-depth must be light or full/);
  assert.deepEqual(parseOptions(['seats', '--host', 'claude-code', '--audit-depth', 'full', '--mode', 'adversarial']).options, { host: 'claude-code', 'audit-depth': 'full', mode: 'adversarial' });
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
