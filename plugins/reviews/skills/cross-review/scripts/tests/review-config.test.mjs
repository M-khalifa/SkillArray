import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, readConfig, writeConfig, resolveConfig, parseOptions } from '../review-config.mjs';

test('first setup requires two distinct pair models', () => {
  assert.throws(() => resolveConfig(null, 'pair-review', { a: 'opus' }), /Invalid reviewer B/);
  assert.throws(() => resolveConfig(null, 'pair-review', { a: 'opus', b: 'opus' }), /distinct/);
  const c = resolveConfig(null, 'pair-review', { a: 'opus', b: 'sonnet' });
  assert.equal(c.reviewers.B.effort, 'default');
  assert.equal(c.mode, 'collaborate');
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
    'b-provider': 'anthropic', 'b-runtime': 'claude', b: 'fable',
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

test('CLI setup, resolve, reconfigure, show, reset preserve per-skill isolation', async (t) => {
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

test('catalog command exposes current OpenAI tiers and Fable', () => {
  const script = fileURLToPath(new URL('../review-config.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'catalog'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.providers.openai.models.map((model) => model.id), [
    'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ]);
  assert.ok(value.providers.anthropic.models.some((model) => model.id === 'fable'));
});
