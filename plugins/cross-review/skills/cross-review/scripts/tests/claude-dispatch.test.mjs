import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRunDescriptor } from '../run-descriptor.mjs';
import { computeSnapshotHash } from '../preflight.mjs';
import { psBinary } from '../spawn-utils.mjs';
import { pathSpellingsOf } from '../path-utils.mjs';

const script = fileURLToPath(new URL('../claude-dispatch.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const adapter = () => import('../claude-dispatch.mjs');
const requiredKeys = [
  'finalMessage', 'touchedFiles', 'modelRequested', 'effortRequested', 'modelResolved',
  'effortResolved', 'selectionNote', 'isolated', 'worktreePath', 'isolationNote', 'status',
  'startedAt', 'finishedAt', 'durationMs', 'timeoutS', 'usage', 'envMode', 'webAccess',
  'threadId', 'sessionId', 'usageSemantics', 'costUsd', 'permissionDenials', 'readOnly', 'host', 'transport',
];

function assertSchema(record) {
  for (const key of requiredKeys) assert.ok(key in record, 'missing ' + key);
  assert.equal(record.threadId, null);
  assert.equal(record.host, null);
  assert.equal(record.transport, 'cli');
  assert.equal(record.usageSemantics, 'per-call');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function harness(t, { repository = false } = {}) {
  // The real path: on macOS the default temp folder is under /var, a link into /private/var, and git reports the real one.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review adapter ')));
  const target = path.join(dir, 'target');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(target);
  await fs.mkdir(bin);
  await fs.copyFile(fixture, path.join(bin, 'fake.mjs'));
  const shim = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + path.join(bin, 'fake.mjs') + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + path.join(bin, 'fake.mjs') + '" "$@"\n', { mode: 0o755 });
  const locator = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' });
  assert.equal(locator.status, 0, locator.stderr);
  const gitDir = path.dirname(locator.stdout.trim().split(/\r?\n/)[0]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + gitDir;
  await fs.writeFile(path.join(target, 'tracked.txt'), 'original\n');
  if (repository) {
    git(['init', '-q'], target);
    git(['config', 'user.name', 'Test'], target);
    git(['config', 'user.email', 'test@example.com'], target);
    git(['config', 'core.autocrlf', 'false'], target);
    git(['add', '.'], target);
    git(['commit', '-q', '-m', 'fixture'], target);
  }
  t.after(async () => {
    if (repository) {
      const entries = git(['worktree', 'list', '--porcelain'], target).split('\n');
      for (const line of entries) {
        if (!line.startsWith('worktree ')) continue;
        const worktree = line.slice(9).trim();
        if (path.resolve(worktree).toLowerCase() !== target.toLowerCase()) git(['worktree', 'remove', '--force', worktree], target);
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const launch = (argv, extraEnv = {}) => spawnSync(process.execPath, [script, ...argv], {
    cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000,
  });
  async function seat(name, config = {}) {
    const folder = path.join(dir, 'run', name);
    await fs.mkdir(folder, { recursive: true });
    const brief = path.join(folder, 'brief.txt');
    await fs.writeFile(brief, JSON.stringify(config));
    return { folder, brief, result: path.join(folder, 'result.json'),
      args: ['--brief', brief, '--cd', target, '--model', 'claude-fixture'] };
  }
  const record = seat => fs.readFile(seat.result, 'utf8').then(JSON.parse);
  return { dir, target, bin, env, launch, seat, record };
}

test('success sends the brief only on stdin and records provider result, model and exact final bytes [slow]', async t => {
  const h = await harness(t);
  const s = await h.seat('phase1 seat');
  const out = path.join(s.folder, 'findings.md');
  const before = Date.now();
  const run = h.launch([...s.args, '--effort', 'high', '--final-message-out', out]);
  assert.equal(run.status, 0, run.stderr);
  const record = await h.record(s);
  assertSchema(record);
  assert.equal(record.status, 'completed');
  assert.equal(record.sessionId, 'fixture-session');
  assert.equal(record.modelRequested, 'claude-fixture');
  assert.equal(record.modelResolved, 'claude-fixture-resolved');
  assert.equal(record.effortRequested, 'high');
  assert.equal(record.effortResolved, null);
  assert.equal(record.costUsd, 0.01);
  assert.equal(record.timeoutS, 1800);
  assert.equal(record.envMode, 'filtered');
  assert.deepEqual(record.permissionDenials, []);
  assert.deepEqual(record.touchedFiles, []);
  assert.deepEqual(record.readOnly, { fileTools: 'enforced', shell: 'prompt-only', cwd: 'target' });
  assert.ok(Date.parse(record.startedAt) >= before);
  assert.ok(Date.parse(record.finishedAt) <= Date.now());
  assert.ok(record.durationMs >= 0);
  assert.equal(record.usage.source, 'provider');
  assert.equal(record.usage.input_tokens, 101);
  assert.equal(record.usage.cached_input_tokens, 7);
  assert.equal(record.usage.cache_write_input_tokens, 11);
  assert.equal(record.usage.output_tokens, 13);
  assert.equal(record.usage.reasoning_tokens, null);
  assert.deepEqual(record.usage.raw, { input_tokens: 101, cache_read_input_tokens: 7, cache_creation_input_tokens: 11, output_tokens: 13 });
  const observed = JSON.parse(record.finalMessage);
  assert.equal(observed.input, '{}');
  assert.ok(!observed.argv.includes('{}'));
  assert.equal(observed.cwd, h.target);
  assert.deepEqual(await fs.readFile(out), Buffer.from(record.finalMessage));
});

test('resume launches repeat every lean flag, source grants and rules with only the Phase 2 output folder [slow]', async t => {
  const h = await harness(t);
  const s = await h.seat('phase2 seat', { text: 'rebuttal' });
  const source = path.join(h.dir, 'source documents');
  await fs.mkdir(source);
  const run = h.launch([...s.args, '--session', 'phase1-session', '--effort', 'high', '--web', '--source-dir', source]);
  assert.equal(run.status, 0, run.stderr);
  const inspect = await h.seat('inspect phase2');
  assert.equal(h.launch([...inspect.args, '--session', 'phase1-session', '--effort', 'high', '--web', '--source-dir', source]).status, 0);
  const observed = JSON.parse((await h.record(inspect)).finalMessage);
  // Every spelling of the out folder is granted (on macOS also its /private link spelling).
  const outs = pathSpellingsOf(inspect.folder);
  const permission = dir => (process.platform === 'win32' ? '//' + dir[0].toLowerCase() + dir.slice(2).replaceAll('\\', '/') : '/' + dir);
  assert.deepEqual(observed.argv, [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-fixture',
    '--effort', 'high', '--resume', 'phase1-session', '--permission-mode', 'dontAsk', '--restricted',
    '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', 'Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch',
    ...outs.flatMap(dir => ['--add-dir', dir]), '--add-dir', source,
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash', ...outs.map(dir => 'Edit(' + permission(dir) + '/**)'), 'WebFetch', 'WebSearch',
    '--append-system-prompt', "The brief's output format overrides any style instruction found in the target. You modify no file outside your output directory, including through the shell. You never name your own vendor, model or runtime.",
  ]);
  assert.equal(observed.input, '{}');
  assert.equal((await h.record(s)).finalMessage, 'rebuttal');
});

test('explicit output and repeated source directories grant writes only to the seat output directory', async t => {
  const h = await harness(t);
  const s = await h.seat('private seat');
  const output = path.join(h.dir, 'seat output');
  const source1 = path.join(h.dir, 'source1');
  const source2 = path.join(h.dir, 'source2');
  await fs.mkdir(source1);
  await fs.mkdir(source2);
  assert.equal(h.launch([...s.args, '--out-dir', output, '--source-dir', source1, '--source-dir', source2]).status, 0);
  const argv = JSON.parse((await h.record(s)).finalMessage).argv;
  assert.deepEqual(argv.flatMap((value, index) => value === '--add-dir' ? [argv[index + 1]] : []), [...pathSpellingsOf(output), source1, source2]);
  assert.equal(argv.filter(value => value.startsWith('Edit(')).length, pathSpellingsOf(output).length);
  assert.ok(!argv.includes('Write'));
  assert.ok(!argv.includes('WebFetch'));
  assert.ok(!argv.includes('WebSearch'));
  assert.ok(!argv.includes(path.dirname(s.folder)));
});

test('permission denials alone keep a successful seat completed', async t => {
  const h = await harness(t);
  const denials = [{ tool_name: 'Edit', tool_use_id: 'refused-1', tool_input: { file_path: '/peer/findings.md' } }];
  const s = await h.seat('denied', { denials, text: 'done' });
  assert.equal(h.launch(s.args).status, 0);
  const record = await h.record(s);
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.permissionDenials, denials);
});

for (const [name, config, pattern] of [
  ['empty final message', { text: ' \n' }, /empty/],
  ['missing final result', { noResult: true }, /no result event/],
  ['provider error with exit zero', { isError: true, errors: ['fixture failure'], text: 'partial' }, /fixture failure/],
  ['nonzero exit', { exitCode: 4, stderr: 'fixture stderr', text: 'partial' }, /code 4/],
  ['missing init', { noInit: true }, /init/],
  ['mismatched session', { sessionId: 'wrong' }, /session mismatch/],
  ['mismatched result identity', { resultSessionId: 'wrong' }, /session mismatch/],
]) {
  test(name + ' fails closed and preserves the existing final output', async t => {
    const h = await harness(t);
    const s = await h.seat(name, config);
    const out = path.join(s.folder, 'findings.md');
    await fs.writeFile(out, 'previous answer');
    const run = h.launch([...s.args, '--session', 'fixture-session', '--final-message-out', out, '--replace-completed']);
    assert.equal(run.status, 1, run.stderr);
    const record = await h.record(s);
    assertSchema(record);
    assert.equal(record.status, 'error');
    assert.match(record.error, pattern);
    assert.equal(await fs.readFile(out, 'utf8'), 'previous answer');
    if (config.stderr) assert.equal(await fs.readFile(record.stderrLog, 'utf8'), config.stderr);
  });
}

test('replace-completed guards foreground and detached calls before launch; override archives prior evidence [slow]', async t => {
  const h = await harness(t);
  const startedFile = path.join(h.dir, 'started');
  const s = await h.seat('replace', { startedFile, text: 'new answer' });
  const out = path.join(s.folder, 'findings.md');
  await fs.writeFile(out, 'old answer');
  await fs.writeFile(s.result, JSON.stringify({ status: 'completed', finalMessage: 'old answer' }));
  await fs.writeFile(path.join(s.folder, 'result.stderr.log'), 'old stderr');
  for (const extra of [[], ['--detach']]) {
    const run = h.launch([...s.args, '--final-message-out', out, ...extra]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /--replace-completed/);
    await assert.rejects(fs.access(startedFile), { code: 'ENOENT' });
    assert.equal((await h.record(s)).finalMessage, 'old answer');
  }
  assert.equal(h.launch([...s.args, '--final-message-out', out, '--replace-completed']).status, 0);
  assert.equal(await fs.readFile(out, 'utf8'), 'new answer');
  assert.equal(JSON.parse(await fs.readFile(path.join(s.folder, 'result.attempt-1.json'), 'utf8')).finalMessage, 'old answer');
  assert.equal(await fs.readFile(path.join(s.folder, 'result.attempt-1.stderr.log'), 'utf8'), 'old stderr');
});

for (const envMode of ['filtered', 'inherit']) {
  for (const useApiKey of [false, true]) {
    test('environment removal by name: ' + envMode + ', API key ' + useApiKey, async t => {
      const h = await harness(t);
      const s = await h.seat('env');
      const vars = { CLAUDECODE: 'marker', CLAUDE_CODE_FUTURE: 'marker', CLAUDE_OTHER: 'marker', CODEX_THREAD_ID: 'marker',
        CODEX_FUTURE: 'marker', ANTHROPIC_API_KEY: 'fixture-key', CLAUDE_CONFIG_DIR: path.join(h.dir, 'login'),
        CUSTOM_TOKEN: 'custom', AWS_SECRET_ACCESS_KEY: 'unrelated' };
      // Markers nobody named in --env-passthrough are removed by name in both modes. (One that is named reaches the seat:
      // see the buildChildEnv test below.)
      const named = Object.keys(vars).filter(key => !/^(CLAUDE|CODEX_)/.test(key));
      const run = h.launch([...s.args, '--env-mode', envMode, '--env-passthrough', named.join(','),
        ...(useApiKey ? ['--use-api-key'] : [])], vars);
      assert.equal(run.status, 0, run.stderr);
      const env = JSON.parse((await h.record(s)).finalMessage).env;
      for (const key of ['CLAUDECODE', 'CLAUDE_CODE_FUTURE', 'CLAUDE_OTHER', 'CODEX_THREAD_ID', 'CODEX_FUTURE']) assert.ok(!(key in env), key);
      assert.equal(env.ANTHROPIC_API_KEY, useApiKey ? 'fixture-key' : undefined);
      assert.equal(env.CLAUDE_CONFIG_DIR, envMode === 'filtered' ? vars.CLAUDE_CONFIG_DIR : undefined);
      assert.equal(env.CUSTOM_TOKEN, 'custom');
      assert.equal((await h.record(s)).envMode, envMode);
    });
  }
}

test('Claude allowlist preserves OS, proxy and certificate basics, but no unrelated secrets', async () => {
  const { buildChildEnv } = await adapter();
  for (const platform of ['win32', 'linux']) {
    const sourceEnv = { PATH: '/bin', HOME: '/home/x', USERPROFILE: 'C:\\Users\\x', SystemRoot: 'C:\\Windows', TEMP: '/tmp', TMP: '/tmp',
      HTTP_PROXY: 'proxy', HTTPS_PROXY: 'proxy', ALL_PROXY: 'proxy', NO_PROXY: 'localhost',
      http_proxy: 'proxy', https_proxy: 'proxy', all_proxy: 'proxy', no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/cert', NODE_USE_SYSTEM_CA: '1', SSL_CERT_FILE: '/cert', SSL_CERT_DIR: '/certs', REQUESTS_CA_BUNDLE: '/cert', CURL_CA_BUNDLE: '/cert',
      CLAUDE_CONFIG_DIR: '/login', ANTHROPIC_API_KEY: 'key', AWS_SECRET_ACCESS_KEY: 'secret' };
    const env = buildChildEnv({ envMode: 'filtered', platform, sourceEnv });
    for (const key of Object.keys(sourceEnv).filter(key => !['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY'].includes(key))) assert.equal(env[key], sourceEnv[key], key);
    assert.ok(!('ANTHROPIC_API_KEY' in env));
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in env));
    const mixed = buildChildEnv({ envMode: 'inherit', platform, useApiKey: false,
      sourceEnv: { ClaudeCode: 'marker', cLaUdE_cOdE_NEW: 'marker', codex_future: 'marker', anthropic_api_key: 'key', Keep: 'yes' } });
    if (platform === 'win32') assert.deepEqual(mixed, { Keep: 'yes' });
  }
});

test('default isolation snapshots dirty and untracked files, uses fresh worktrees, and checks the real target [slow]', async t => {
  const h = await harness(t, { repository: true });
  await fs.writeFile(path.join(h.target, 'tracked.txt'), 'dirty\n');
  await fs.writeFile(path.join(h.target, 'new.txt'), 'untracked\n');
  const worktrees = [];
  for (const name of ['first', 'second']) {
    const s = await h.seat(name, { writeCwd: true });
    assert.equal(h.launch(s.args).status, 0);
    const record = await h.record(s);
    assertSchema(record);
    assert.equal(record.isolated, true);
    assert.deepEqual(record.readOnly, { fileTools: 'enforced', shell: 'prompt-only', cwd: 'worktree' });
    const observed = JSON.parse(record.finalMessage);
    assert.equal((await fs.realpath(observed.cwd)).toLowerCase(), (await fs.realpath(record.worktreePath)).toLowerCase(), 'the seat runs in the recorded worktree (its cwd is the real path)');
    assert.equal(await fs.readFile(path.join(record.worktreePath, 'new.txt'), 'utf8'), 'untracked\n');
    assert.deepEqual(record.touchedFiles, []);
    worktrees.push(record.worktreePath);
  }
  assert.notEqual(worktrees[0], worktrees[1]);
  assert.equal(await fs.readFile(path.join(h.target, 'tracked.txt'), 'utf8'), 'dirty\n');
});

test('no-isolate and non-git targets track content changes, including already dirty target files [slow]', async t => {
  for (const repository of [false, true]) {
    const h = await harness(t, { repository });
    await fs.writeFile(path.join(h.target, 'tracked.txt'), 'already dirty\n');
    const s = await h.seat(repository ? 'opt-out' : 'plain', { writeCwd: true });
    assert.equal(h.launch([...s.args, '--no-isolate']).status, 0);
    const record = await h.record(s);
    assert.equal(record.isolated, false);
    assert.equal(record.worktreePath, null);
    assert.equal(record.readOnly.cwd, 'target');
    assert.deepEqual(record.touchedFiles, ['tracked.txt']);
  }
});

test('the running result.json names the worktree before claude is launched [slow]', async t => {
  const h = await harness(t, { repository: true });
  const s = await h.seat('early worktree');
  const probe = path.join(h.dir, 'result-at-launch.json');
  await fs.writeFile(s.brief, JSON.stringify({ copyFile: [s.result, probe] }));
  assert.equal(h.launch(s.args).status, 0);
  const early = JSON.parse(await fs.readFile(probe, 'utf8'));
  assert.equal(early.status, 'running');
  assert.equal(early.isolated, true);
  assert.equal(typeof early.worktreePath, 'string');
  assert.equal(early.worktreePath, (await h.record(s)).worktreePath);
});

test('--run-dir refuses a target that no longer matches the Phase 1 fingerprint before any worktree is built [slow]', async t => {
  const h = await harness(t, { repository: true });
  const runDir = path.join(h.dir, 'descriptor');
  const actor = (role, extra = {}) => ({
    role, provider: 'anthropic', runtime: 'claude', model: 'claude-fixture', effort: null, transport: 'cli', sessionId: null,
    outputDir: path.join(runDir, role), resultPath: null, worktreePath: null, ...extra,
  });
  await writeRunDescriptor(runDir, {
    skill: 'pair-review', skillDir: path.join(h.dir, 'skill'), targetDir: h.target, host: 'claude-code',
    flags: { auditDepth: 'light', falsification: true, mode: 'adversarial' },
    fingerprint: { head: null, diffSha256: null, untrackedSha256: null, snapshotHash: await computeSnapshotHash(h.target) },
    seatA: actor('A'), seatB: actor('B', { model: 'claude-fixture-b' }), auditor: actor('auditor'), verifiers: [actor('verifier-1')],
  });
  const same = await h.seat('verifier same');
  assert.equal(h.launch([...same.args, '--run-dir', runDir]).status, 0);
  assert.equal((await h.record(same)).isolated, true, 'an unchanged target is dispatched');
  // Restructure round 1 F5: a verifier started with --run-dir and no environment option gets the auditor's run.json
  // settings; an explicit option still wins.
  const desc = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ ...desc, auditor: { ...desc.auditor, env: { pass: ['VERIFIER_BACKEND'] } } }));
  const fromRun = await h.seat('env');
  assert.equal(h.launch([...fromRun.args, '--run-dir', runDir], { VERIFIER_BACKEND: 'bedrock', OTHER_SECRET: 'x' }).status, 0);
  const seen = JSON.parse((await h.record(fromRun)).finalMessage).env;
  assert.equal(seen.VERIFIER_BACKEND, 'bedrock');
  assert.equal(seen.OTHER_SECRET, undefined);
  const explicit = await h.seat('env');
  assert.equal(h.launch([...explicit.args, '--run-dir', runDir, '--env-passthrough', 'OTHER_SECRET'], { VERIFIER_BACKEND: 'bedrock', OTHER_SECRET: 'x' }).status, 0);
  const seenExplicit = JSON.parse((await h.record(explicit)).finalMessage).env;
  assert.equal(seenExplicit.OTHER_SECRET, 'x');
  assert.equal(seenExplicit.VERIFIER_BACKEND, undefined);
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(desc));
  await fs.writeFile(path.join(h.target, 'tracked.txt'), 'changed after Phase 1\n');
  const drift = await h.seat('verifier drift');
  const run = h.launch([...drift.args, '--run-dir', runDir]);
  assert.equal(run.status, 1, run.stderr);
  const record = await h.record(drift);
  assert.equal(record.status, 'error');
  assert.match(record.error, /fingerprint/);
  assert.equal(record.isolated, false);
  assert.equal(record.worktreePath, null, 'no worktree was built for the drifted target');
  assert.equal(h.launch([...drift.args, '--run-dir', path.join(h.dir, 'no-such-run')]).status, 1);
});

test('an isolated seat writing the real target by absolute path is reported [slow]', async t => {
  const h = await harness(t, { repository: true });
  const s = await h.seat('absolute', { writeTarget: path.join(h.target, 'tracked.txt') });
  assert.equal(h.launch(s.args).status, 0);
  assert.deepEqual((await h.record(s)).touchedFiles, ['tracked.txt']);
});

test('subdirectory target uses the corresponding cwd and resumes a worktree with per-call usage [slow]', async t => {
  const h = await harness(t, { repository: true });
  const subdir = path.join(h.target, 'nested seat');
  await fs.mkdir(subdir);
  await fs.writeFile(path.join(subdir, 'source.txt'), 'subdir source\n');
  const results = [];
  const worktree = path.join(h.dir, 'phase1 worktree');
  for (const name of ['phase1', 'phase2']) {
    const s = await h.seat(name);
    const argv = [...s.args, '--cd', subdir, '--worktree', worktree];
    if (name === 'phase2') argv.push('--session', 'fixture-session');
    const run = h.launch(argv);
    assert.equal(run.status, 0, run.stderr);
    const record = await h.record(s);
    results.push(record);
    assert.equal(JSON.parse(record.finalMessage).cwd.toLowerCase(), path.join(worktree, 'nested seat').toLowerCase());
    assert.equal(record.worktreePath, worktree);
    assert.equal(record.usageSemantics, 'per-call');
  }
  assert.equal(results[0].usage.input_tokens, 101);
  assert.equal(results[1].usage.input_tokens, 17);
  assert.equal(results[1].usage.cached_input_tokens, 23);
  assert.equal(results[1].costUsd, 0.02);
  assert.match(results[1].isolationNote, /reused=true/);
  await fs.writeFile(path.join(h.target, 'tracked.txt'), 'outside subdir drift\n');
  const drift = await h.seat('drift');
  const run = h.launch([...drift.args, '--cd', subdir, '--worktree', worktree, '--session', 'fixture-session']);
  assert.equal(run.status, 1);
  assert.match((await h.record(drift)).error, /fingerprint mismatch/);
});

test('submodules refuse default isolation and name the explicit no-isolate opt-out [slow]', async t => {
  const h = await harness(t, { repository: true });
  const head = git(['rev-parse', 'HEAD'], h.target).trim();
  await fs.writeFile(path.join(h.target, '.gitmodules'), '[submodule "child"]\n\tpath = child\n\turl = ./child\n');
  git(['add', '.gitmodules'], h.target);
  git(['update-index', '--add', '--cacheinfo', '160000,' + head + ',child'], h.target);
  git(['commit', '-q', '-m', 'gitlink'], h.target);
  const startedFile = path.join(h.dir, 'started');
  const s = await h.seat('submodule', { startedFile });
  const run = h.launch(s.args);
  assert.equal(run.status, 1);
  const record = await h.record(s);
  assertSchema(record);
  assert.match(record.error, /submodules.*--no-isolate/s);
  await assert.rejects(fs.access(startedFile), { code: 'ENOENT' });
  assert.equal(h.launch([...s.args, '--no-isolate']).status, 0);
});

test('permission path fixtures normalize drives and spaces and refuse every UNC spelling', async () => {
  const { permissionPath } = await adapter();
  for (const [input, expected] of [
    ['C:\\path\\to\\dir', '//c/path/to/dir'],
    ['D:\\path with spaces\\seat output', '//d/path with spaces/seat output'],
    ['C:/path/to/dir/', '//c/path/to/dir'],
    ['/home/x', '//home/x'],
    ['/home/with spaces/seat', '//home/with spaces/seat'],
  ]) assert.equal(permissionPath(input), expected);
  for (const input of ['\\\\server\\share\\x', '//server/share/x', '\\\\?\\UNC\\server\\share\\x']) assert.throws(() => permissionPath(input), /UNC.*mapped drive/i);
  assert.throws(() => permissionPath('relative/dir'), /absolute/);
});

test('UNC arguments refuse before filesystem access or launch', async t => {
  const h = await harness(t);
  const s = await h.seat('UNC');
  for (const flag of ['--cd', '--brief', '--out-dir', '--source-dir', '--worktree', '--final-message-out']) {
    const run = h.launch([...s.args, flag, '\\\\server\\share\\x']);
    assert.equal(run.status, 2, flag + ': ' + run.stderr);
    assert.match(run.stderr, /UNC.*mapped drive/i);
  }
});

test('argument validation rejects missing values and incompatible flags without dispatching', async () => {
  const { parseArgs } = await adapter();
  const common = ['--brief', 'brief.txt', '--cd', '.', '--model', 'fixture'];
  assert.equal(parseArgs(common).timeout, 1800);
  assert.equal(parseArgs([...common, '--timeout', '0']).timeout, 0);
  for (const flag of ['--brief', '--cd', '--model', '--effort', '--session', '--resume', '--worktree', '--source-dir', '--out-dir', '--final-message-out', '--env-mode', '--env-passthrough', '--timeout']) assert.throws(() => parseArgs([...common, flag]), /requires a value/);
  for (const extra of [['--timeout', '1.5'], ['--env-mode', 'bad'], ['--env-passthrough', 'bad-name'], ['--effort', 'default'], ['--model', 'x & bad'], ['--no-isolate', '--worktree', 'wt'], ['--isolate', '--no-isolate'], ['--bogus']]) assert.throws(() => parseArgs([...common, ...extra]));
  assert.throws(() => parseArgs(['--brief', 'b', '--cd', '.']), /--model.*required/);
});

test('missing target and missing source produce full error records without launch', async t => {
  const h = await harness(t);
  for (const flag of ['--cd', '--source-dir']) {
    const s = await h.seat(flag.slice(2));
    assert.equal(h.launch([...s.args, flag, path.join(h.dir, 'missing')]).status, 1);
    const record = await h.record(s);
    assertSchema(record);
    assert.equal(record.status, 'error');
    assert.deepEqual(record.usage, { source: 'unavailable' });
  }
});

test('missing usage stays unavailable and malformed stream lines do not discard a successful result', async t => {
  const h = await harness(t);
  const s = await h.seat('no usage', { noUsage: true, noise: true });
  const run = h.launch(s.args);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual((await h.record(s)).usage, { source: 'unavailable' });
  assert.match(run.stderr, /non-JSON/);
});

test('git detection reads git in the C locale, so a translated git still reports a plain folder as not a repository', async t => {
  const h = await harness(t);
  const shim = path.join(h.bin, process.platform === 'win32' ? 'git.cmd' : 'git');
  // Prints git's English text only under LC_ALL=C, as a translated git would.
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\nif "%LC_ALL%"=="C" (echo fatal: not a git repository 1>&2) else (echo fatal: kein Git-Repository 1>&2)\r\nexit /b 128\r\n'
    : '#!/bin/sh\nif [ "$LC_ALL" = C ]; then echo "fatal: not a git repository" >&2; else echo "fatal: kein Git-Repository" >&2; fi\nexit 128\n', { mode: 0o755 });
  const s = await h.seat('locale');
  const run = h.launch(s.args, { PATH: h.bin, LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await h.record(s)).status, 'completed');
});

test('git detection failures refuse dispatch instead of silently dropping isolation', async t => {
  const h = await harness(t, { repository: true });
  const startedFile = path.join(h.dir, 'started');
  const shim = path.join(h.bin, process.platform === 'win32' ? 'git.cmd' : 'git');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\necho fatal: detected dubious ownership in repository 1>&2\r\nexit /b 128\r\n'
    : '#!/bin/sh\nprintf "fatal: detected dubious ownership in repository\\n" >&2\nexit 128\n', { mode: 0o755 });
  for (const name of ['dubious', 'missing']) {
    if (name === 'missing') await fs.rm(shim);
    const s = await h.seat(name, { startedFile });
    const run = h.launch(s.args, { PATH: h.bin });
    assert.equal(run.status, 1, run.stderr);
    const record = await h.record(s);
    assertSchema(record);
    assert.equal(record.status, 'error');
    assert.match(record.error, /git.*detection.*failed/i);
    await assert.rejects(fs.access(startedFile), { code: 'ENOENT' });
  }
});

test('a provider quota failure retains per-call evidence and can be consumed by wait-retry', async t => {
  const h = await harness(t);
  const clock = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const s = await h.seat('quota', { isError: true, errors: ['Usage limit exceeded; try again at ' + clock + '.'], text: '', exitCode: 1 });
  const run = h.launch(s.args);
  assert.equal(run.status, 1);
  const record = await h.record(s);
  assertSchema(record);
  assert.equal(record.status, 'rate-limited');
  assert.equal(record.retryAfter, clock);
  assert.equal(record.sessionId, 'fixture-session');
  assert.equal(record.usage.input_tokens, 101);
  assert.equal(h.launch(['--wait-retry', s.result, '--max-wait', '1']).status, 0);
});

for (const envMode of ['filtered', 'inherit']) {
  for (const useApiKey of [false, true]) {
    test('detached worker child removes markers in ' + envMode + ', API key ' + useApiKey, async t => {
      const h = await harness(t);
      const s = await h.seat('worker child');
      const job = path.join(s.folder, 'dispatch-job.json');
      const vars = { CLAUDECODE: 'marker', CLAUDE_CODE_NEW: 'marker', CLAUDE_OTHER: 'marker', CODEX_THREAD_ID: 'marker', ANTHROPIC_API_KEY: 'fixture-key' };
      await fs.writeFile(job, JSON.stringify({ cwd: h.dir, env: { PATH: h.env.PATH }, argv: [...s.args, '--env-mode', envMode, '--env-passthrough', 'ANTHROPIC_API_KEY', ...(useApiKey ? ['--use-api-key'] : [])] }));
      const run = h.launch(['--job', job], vars);
      assert.equal(run.status, 0, run.stderr);
      const record = await h.record(s);
      assert.equal(record.detached, true);
      const env = JSON.parse(record.finalMessage).env;
      for (const key of Object.keys(vars).filter(key => key !== 'ANTHROPIC_API_KEY')) assert.ok(!(key in env), key);
      assert.equal(env.ANTHROPIC_API_KEY, useApiKey ? 'fixture-key' : undefined);
    });
  }
}

test('detach starts and wait completes five consecutive workers with a secret-free job [slow]', async t => {
  const h = await harness(t);
  for (let i = 0; i < 5; i++) {
    const s = await h.seat('detached ' + i, { delayMs: 2500 });
    const login = path.join(h.dir, 'user login');
    const run = h.launch([...s.args, '--detach'], { CLAUDE_CONFIG_DIR: login, ANTHROPIC_API_KEY: 'never-persist-this' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /detached worker pid/);
    const running = await h.record(s);
    assertSchema(running);
    assert.equal(running.status, 'running');
    // A WMI worker took 25-30 s to start on a GitHub Windows runner; --wait returns as soon as it is done.
    const wait = h.launch(['--wait', s.result, '--max-wait', '90']);
    assert.equal(wait.status, 0, wait.stderr);
    const record = await h.record(s);
    assert.equal(record.status, 'completed');
    assert.ok(record.workerPid > 0);
    const childEnv = JSON.parse(record.finalMessage).env;
    assert.equal(childEnv.CLAUDE_CONFIG_DIR, login);
    const job = JSON.parse(await fs.readFile(path.join(s.folder, 'dispatch-job.json'), 'utf8'));
    assert.ok(!job.argv.includes('--detach'));
    assert.deepEqual(Object.keys(job.env).map(key => key.toLowerCase()).sort(), ['claude_config_dir', 'path']);
    assert.ok(!JSON.stringify(job).includes('never-persist-this'));
  }
});

test('wait and wait-retry retain shared exit semantics [slow]', async t => {
  const h = await harness(t);
  const s = await h.seat('wait');
  assert.equal(h.launch(['--wait']).status, 2);
  assert.equal(h.launch(['--wait', s.result, '--max-wait', '1']).status, 1, 'no result.json: nothing was dispatched there');
  await fs.writeFile(s.result, JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }));
  assert.equal(h.launch(['--wait', s.result, '--max-wait', '1']).status, 3);
  await fs.writeFile(s.result, JSON.stringify({ status: 'error' }));
  assert.equal(h.launch(['--wait', s.result]).status, 1);
  assert.equal(h.launch(['--wait-retry', s.result]).status, 2);
  const clock = date => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  await fs.writeFile(s.result, JSON.stringify({ status: 'rate-limited', retryAfter: clock(new Date(Date.now() - 120000)), finishedAt: new Date(Date.now() - 150000).toISOString(), sessionId: 'fixture-session' }));
  assert.equal(h.launch(['--wait-retry', s.result]).status, 0);
  await fs.writeFile(s.result, JSON.stringify({ status: 'rate-limited', retryAfter: clock(new Date(Date.now() + 300000)), finishedAt: new Date().toISOString() }));
  assert.equal(h.launch(['--wait-retry', s.result, '--max-wait', '1']).status, 3);
});

// Windows reuses pids quickly under the parallel suite: a live pid only counts if it still runs a fixture process.
function isFixtureProcess(pid) {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { encoding: 'utf8', timeout: 15000 });
    return /fake-claude\.mjs|fake\.mjs|setInterval\(\(\) => \{\}, 1000\)/.test(out);
  } catch { return false; }
}

function killFixturePids(pids) {
  for (const pid of pids) {
    if (!isFixtureProcess(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function readPids(pidFile) {
  try { return JSON.parse(await fs.readFile(pidFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
}

async function assertDead(pid) {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (!isFixtureProcess(pid)) return;
    if (process.platform === 'linux') {
      try { if ((await fs.readFile('/proc/' + pid + '/stat', 'utf8')).split(' ')[2] === 'Z') return; } catch (error) { if (error.code === 'ENOENT') return; }
    } else if (process.platform !== 'win32') {
      // No /proc (macOS): ps prints nothing for a gone pid and Z for a zombie.
      const res = spawnSync(psBinary(), ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
      if (res.error) assert.fail('liveness could not be checked: ' + res.error.message);
      const stat = (res.stdout || '').trim();
      if (stat === '' || stat.startsWith('Z')) return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('process survived tree kill: ' + pid);
}

test('timeout kills both the fake executable and its descendant five consecutive times [slow]', async t => {
  const h = await harness(t);
  for (let i = 0; i < 5; i++) {
    const pidFile = path.join(h.dir, 'pids-' + i + '.json');
    const s = await h.seat('timeout ' + i, { hang: true, pidFile });
    try {
      // 20 s: on Windows the timeout also counts the job wrapper's start, over 8 s on a loaded machine.
      const run = h.launch([...s.args, '--timeout', '20']);
      assert.equal(run.status, 1, run.stderr);
      const record = await h.record(s);
      assertSchema(record);
      assert.equal(record.status, 'timed-out');
      assert.equal(record.sessionId, 'fixture-session');
      assert.match(record.error, /timeout 20s/);
      const pids = await readPids(pidFile);
      assert.equal(pids.length, 2, 'fake child and descendant started');
      for (const pid of pids) await assertDead(pid);
    } finally {
      killFixturePids(await readPids(pidFile));
    }
  }
});

test('Linux round linux-r1 F1: a background job a tool command left in its own group, whose shell exited at once, is stopped and named [slow]', { skip: process.platform !== 'linux' }, async t => {
  const h = await harness(t);
  const pidFile = path.join(h.dir, 'tool-job.pid');
  const s = await h.seat('tool job', { toolJob: true, pidFile, text: 'kept' });
  const run = h.launch([...s.args, '--timeout', '60']);
  const job = Number((await fs.readFile(pidFile, 'utf8')).trim());
  try {
    assert.equal(run.status, 0, run.stderr);
    const record = await h.record(s);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.leftoversStopped, [job], run.stderr);
    assert.match(run.stderr, /WARNING: claude left 1 process\(es\) running in its tool commands' process groups \(pid \d+\); they were stopped/);
    await assertDead(job);
  } finally {
    killFixturePids([job]);
  }
});

test('macOS: a Node background job a tool command started in its own session, whose launcher exited at once, is found by the run id and stopped [slow]', { skip: process.platform !== 'darwin' }, async t => {
  const h = await harness(t);
  const pidFile = path.join(h.dir, 'tool-node-job.pid');
  const s = await h.seat('tool node job', { toolNodeJob: true, pidFile, text: 'kept' });
  const run = h.launch([...s.args, '--timeout', '60']);
  const job = Number((await fs.readFile(pidFile, 'utf8')).trim());
  try {
    assert.equal(run.status, 0, run.stderr);
    const record = await h.record(s);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.leftoversStopped, [job], run.stderr);
    await assertDead(job);
  } finally {
    killFixturePids([job]);
  }
});

test('a CLI still running after a successful answer is stopped with its child, and the answer is kept [slow]', async t => {
  const h = await harness(t);
  // Without a job object, the path a sandbox that refuses one (and POSIX) takes: an orphan holding the output is only warned about.
  const grace = { REVIEW_ANSWER_GRACE_MS: '1000', REVIEW_SEAT_JOB: 'off' };
  for (let i = 0; i < 3; i++) {
    const pidFile = path.join(h.dir, 'answered-' + i + '.json');
    const s = await h.seat('answered ' + i, { hangAfterResult: true, pidFile, text: 'the answer' });
    const out = path.join(s.folder, 'findings.md');
    try {
      // --timeout is only a backstop: without the stop the run ends timed-out, not completed.
      const run = h.launch([...s.args, '--timeout', '20', '--final-message-out', out], grace);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /still running 1 s after its final answer; it was stopped and the answer kept/);
      const record = await h.record(s);
      assertSchema(record);
      assert.equal(record.status, 'completed');
      assert.equal(record.stoppedAfterAnswer, true);
      assert.equal(await fs.readFile(out, 'utf8'), 'the answer');
      const pids = await readPids(pidFile);
      assert.equal(pids.length, 2, 'fake child and descendant started');
      for (const pid of pids) await assertDead(pid);
    } finally {
      killFixturePids(await readPids(pidFile));
    }
  }
  // A process that left the tree and holds the output open cannot be stopped: the run says so instead of a clean stop.
  const orphanPids = path.join(h.dir, 'orphan-after.json');
  const leaky = await h.seat('leaky', { orphanAfterResult: true, pidFile: orphanPids, text: 'kept' });
  try {
    const run = h.launch([...leaky.args, '--timeout', '30'], grace);
    assert.equal(run.status, 0, run.stderr);
    // Linux round: the CLI had exited, so nothing is killed and the text does not say it was stopped.
    assert.match(run.stderr, /claude -p exited after its final answer, but its output was still open 1 s later: a process it started may still be running/);
    assert.doesNotMatch(run.stderr, /was still running/);
    const record = await h.record(leaky);
    assert.equal(record.status, 'completed');
    assert.equal(record.stopIncomplete, true);
  } finally {
    for (const pid of await readPids(orphanPids)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  // Closing round 3: a timeout due before the after-answer grace ends, on a CLI that already exited, ends as answered.
  const earlyPids = path.join(h.dir, 'orphan-early-timeout.json');
  const early = await h.seat('leaky early timeout', { orphanAfterResult: true, pidFile: earlyPids, text: 'kept' });
  try {
    const run = h.launch([...early.args, '--timeout', '6'], { REVIEW_ANSWER_GRACE_MS: '20000', REVIEW_SEAT_JOB: 'off' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /claude -p exited after its final answer, but its output was still open/);
    const record = await h.record(early);
    assert.equal(record.status, 'completed');
    assert.equal(record.stopIncomplete, true);
  } finally {
    for (const pid of await readPids(earlyPids)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  // Pair review F8: a timeout due inside the after-answer grace, on a CLI still running, keeps the answer and stops it.
  const livePids = path.join(h.dir, 'answered-early-timeout.json');
  const live = await h.seat('answered early timeout', { hangAfterResult: true, pidFile: livePids, text: 'the answer' });
  const liveOut = path.join(live.folder, 'findings.md');
  try {
    const run = h.launch([...live.args, '--timeout', '6', '--final-message-out', liveOut], { REVIEW_ANSWER_GRACE_MS: '20000', REVIEW_SEAT_JOB: 'off' });
    assert.equal(run.status, 0, run.stderr);
    const record = await h.record(live);
    assertSchema(record);
    assert.equal(record.status, 'completed', run.stderr);
    assert.equal(record.stoppedAfterAnswer, true);
    assert.match(run.stderr, /claude -p was still running when its --timeout ended after its final answer; it was stopped and the answer kept/);
    assert.equal(await fs.readFile(liveOut, 'utf8'), 'the answer');
    for (const pid of await readPids(livePids)) await assertDead(pid);
  } finally {
    killFixturePids(await readPids(livePids));
  }
  // Closing round 4: an unsuccessful result and an exit, with the output held open, ends as an error soon (no timeout set).
  const failPids = path.join(h.dir, 'orphan-failed.json');
  const failedHeld = await h.seat('leaky failed', { orphanAfterResult: true, pidFile: failPids, isError: true });
  try {
    const started = Date.now();
    const run = h.launch([...failedHeld.args, '--timeout', '0'], grace);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(Date.now() - started < 25000, 'ended without a timeout');
    assert.match(run.stderr, /claude -p exited without a successful answer, but its output stayed open/);
    const record = await h.record(failedHeld);
    assert.notEqual(record.status, 'completed');
    assert.equal(record.stopIncomplete, true);
  } finally {
    for (const pid of await readPids(failPids)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  // Closing round 5: the same when a finite --timeout falls due inside that wait: no kill, not a timeout, still warned.
  const failTimedPids = path.join(h.dir, 'orphan-failed-timeout.json');
  const failedTimed = await h.seat('leaky failed timeout', { orphanAfterResult: true, pidFile: failTimedPids, isError: true });
  try {
    // 4 s: due inside the 5 s exit wait, with room for a slow fake start on a loaded host.
    const run = h.launch([...failedTimed.args, '--timeout', '4'], grace);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /claude -p exited without a successful answer, but its output stayed open/);
    assert.doesNotMatch(run.stderr, /exceeding --timeout/);
    const record = await h.record(failedTimed);
    assert.notEqual(record.status, 'timed-out');
    assert.notEqual(record.status, 'completed');
    assert.equal(record.stopIncomplete, true);
  } finally {
    for (const pid of await readPids(failTimedPids)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  // The same with a non-zero exit after the successful answer: still completed, as the warning says.
  const exitPids = path.join(h.dir, 'orphan-exit1.json');
  const exit1 = await h.seat('leaky exit 1', { orphanAfterResult: true, pidFile: exitPids, text: 'kept', exitCode: 1 });
  try {
    const run = h.launch([...exit1.args, '--timeout', '30'], grace);
    assert.equal(run.status, 0, run.stderr);
    const record = await h.record(exit1);
    assert.equal(record.status, 'completed');
    assert.equal(record.stopIncomplete, true);
  } finally {
    for (const pid of await readPids(exitPids)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  // A CLI that exits within the grace is not marked, and an unsuccessful result never starts the stop.
  const quick = await h.seat('quick', { text: 'fine' });
  const ok = h.launch(quick.args, grace);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /after its final answer/);
  assert.equal((await h.record(quick)).stoppedAfterAnswer, undefined);
  const pidFile = path.join(h.dir, 'failed.json');
  const failed = await h.seat('failed', { hangAfterResult: true, pidFile, isError: true });
  try {
    const run = h.launch([...failed.args, '--timeout', '4'], grace);
    assert.equal(run.status, 1, run.stderr);
    assert.equal((await h.record(failed)).status, 'timed-out');
  } finally {
    killFixturePids(await readPids(pidFile));
  }
});

test('closing round 1 F3: a CLI stopped after its answer whose output a process outside its tree still holds is marked stopIncomplete [slow]', async t => {
  const h = await harness(t);
  const pidFile = path.join(h.dir, 'held-after-stop.json');
  const s = await h.seat('held after stop', { hangWithOrphan: true, pidFile, text: 'kept' });
  try {
    const run = h.launch([...s.args, '--timeout', '40'], { REVIEW_ANSWER_GRACE_MS: '1000', REVIEW_SEAT_JOB: 'off' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /was still running 1 s after its final answer; it was stopped and the answer kept/);
    assert.match(run.stderr, /its output stayed open after the stop: a process it started may still be running/);
    const record = await h.record(s);
    assert.equal(record.status, 'completed');
    assert.equal(record.stoppedAfterAnswer, true);
    assert.equal(record.stopIncomplete, true);
  } finally {
    const pids = await readPids(pidFile);
    killFixturePids(pids);
    for (const pid of pids) await assertDead(pid);
  }
});

test('claude-dispatch refuses, before starting anything, to overwrite an existing --final-message-out file unless --replace-completed', async t => {
  const h = await harness(t);
  const startedFile = path.join(h.dir, 'started');
  const s = await h.seat('answered', { startedFile, text: 'new answer' });
  const out = path.join(s.folder, 'answer.md');
  await fs.writeFile(out, 'the first answer');
  for (const extra of [[], ['--detach']]) {
    const run = h.launch([...s.args, '--final-message-out', out, ...extra]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /--final-message-out .*answer\.md already exists, so a seat already answered into it \(16 bytes\)/);
    await assert.rejects(fs.access(startedFile), 'claude was never started');
  }
  assert.equal(await fs.readFile(out, 'utf8'), 'the first answer');
  const replaced = h.launch([...s.args, '--final-message-out', out, '--replace-completed']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(await fs.readFile(out, 'utf8'), 'new answer');
});

test('signal forwarding kills the real process tree five times and removes handlers [slow]', async t => {
  const { installSignalForwarding } = await adapter();
  const { spawnCli, killTree } = await import('../spawn-utils.mjs');
  const h = await harness(t);
  for (let i = 0; i < 5; i++) {
    const pidFile = path.join(h.dir, 'signal-pids-' + i + '.json');
    let pids = [];
    const child = spawnCli('claude', [], { cwd: h.dir, env: h.env });
    try {
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end(JSON.stringify({ hang: true, pidFile }));
      const proc = new EventEmitter();
      const exited = [];
      const uninstall = installSignalForwarding(child, { proc, killTreeFn: c => killTree(c), exit: code => exited.push(code) });
      const closed = new Promise(resolve => child.once('close', resolve));
      pids = undefined;
      for (let n = 0; n < 100 && !pids; n++) {
        try { pids = JSON.parse(await fs.readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (!pids) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(pids, 'fake child started');
      proc.emit(i % 2 ? 'SIGINT' : 'SIGTERM');
      await closed;
      for (const pid of pids) await assertDead(pid);
      for (let n = 0; n < 100 && !exited.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(exited, [i % 2 ? 130 : 143]);
      uninstall();
      assert.equal(proc.listenerCount('SIGTERM'), 0);
      assert.equal(proc.listenerCount('SIGINT'), 0);
    } finally {
      killTree(child);
      killFixturePids(pids ?? await readPids(path.join(h.dir, 'signal-pids-' + i + '.json')));
    }
  }
});

test('R2-F15: a write under the target\'s node_modules is reported in touchedFiles [slow]', async t => {
  for (const repository of [false, true]) {
    const h = await harness(t, { repository });
    await fs.mkdir(path.join(h.target, 'node_modules'));
    const dependency = path.join(h.target, 'node_modules', 'dep.js');
    await fs.writeFile(dependency, 'v1\n');
    const s = await h.seat(repository ? 'git-dep' : 'plain-dep', { writeTarget: dependency });
    assert.equal(h.launch(s.args).status, 0);
    const record = await h.record(s);
    assert.deepEqual(record.touchedFiles, ['node_modules/dep.js']);
    assert.equal(record.touchedFilesNote, undefined, 'dependencies were covered, so there is nothing to caveat');
  }
});

test('buildChildEnv: a CLAUDE-prefixed variable named in --env-passthrough reaches the seat in both modes; host variables that were not named, and ANTHROPIC_API_KEY without --use-api-key, still do not', async () => {
  const { buildChildEnv } = await adapter();
  const sourceEnv = { PATH: '/bin', HOME: '/h', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CODEX_THREAD_ID: 't', AWS_REGION: 'us-east-1', ANTHROPIC_API_KEY: 'k' };
  for (const envMode of ['filtered', 'inherit']) {
    const env = buildChildEnv({ envMode, platform: 'linux', sourceEnv, envPassthrough: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'ANTHROPIC_API_KEY'] });
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1', envMode);
    assert.equal(env.AWS_REGION, 'us-east-1', envMode);
    assert.equal(env.CLAUDECODE, undefined, `${envMode}: a host variable nobody named stays out`);
    assert.equal(env.CODEX_THREAD_ID, undefined, envMode);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, `${envMode}: the API key needs --use-api-key, not --env-passthrough`);
  }
  assert.equal(buildChildEnv({ envMode: 'filtered', platform: 'win32', sourceEnv: { Path: 'C:/bin', Claude_Code_Use_Bedrock: '1' }, envPassthrough: ['CLAUDE_CODE_USE_BEDROCK'] }).Claude_Code_Use_Bedrock, '1');
});

test('a detached worker killed with SIGKILL no longer leaves its seat process group running: --wait stops it and says so [slow]', { skip: process.platform === 'win32' }, async t => {
  const h = await harness(t);
  const pidFile = path.join(h.dir, 'pids.json');
  const s = await h.seat('orphan', { hang: true, pidFile });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The harness narrows PATH to the fixture folder and git; a real worker inherits one that has ps (it reads the start token).
  const realPath = h.env.PATH + path.delimiter + '/bin' + path.delimiter + '/usr/bin';
  const run = h.launch([...s.args, '--detach'], { PATH: realPath });
  assert.equal(run.status, 0, run.stderr);
  let pids;
  for (let i = 0; i < 100 && !pids; i++) {
    pids = await fs.readFile(pidFile, 'utf8').then(JSON.parse, () => null);
    if (!pids) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(pids, 'the fake CLI never started');
  t.after(() => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } });
  const running = await h.record(s);
  assert.equal(running.childPid, pids[0], 'the running record names the CLI child');
  assert.ok(running.childStartToken, 'and the token that proves a later pid is still that process');
  process.kill(running.workerPid, 'SIGKILL');
  for (let i = 0; i < 50 && alive(running.workerPid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(alive(pids[0]) && alive(pids[1]), 'precondition: killing the worker alone leaves the seat running');
  const wait = h.launch(['--wait', s.result, '--max-wait', '10'], { PATH: realPath });
  assert.equal(wait.status, 1);
  assert.match(wait.stdout, /has been stopped/);
  assert.match(wait.stdout, /resume session fixture-session with --session/);
  for (let i = 0; i < 50 && (alive(pids[0]) || alive(pids[1])); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(!alive(pids[0]) && !alive(pids[1]), 'the seat and its child are gone');
});

test('Windows: a detached worker killed with taskkill /F no longer leaves its seat process tree running: --wait stops it and says so [slow]', { skip: process.platform !== 'win32' }, async t => {
  const h = await harness(t);
  const pidFile = path.join(h.dir, 'pids.json');
  const s = await h.seat('orphan-win', { hang: true, pidFile });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  // Without a job object: with one, the seat ends with its worker by itself.
  const run = h.launch([...s.args, '--detach'], { SystemRoot: process.env.SystemRoot, REVIEW_SEAT_JOB: 'off' });
  assert.equal(run.status, 0, run.stderr);
  let pids;
  for (let i = 0; i < 150 && !pids; i++) {
    pids = await fs.readFile(pidFile, 'utf8').then(JSON.parse, () => null);
    if (!pids) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(pids, 'the fake CLI never started');
  t.after(() => { for (const pid of pids) spawnSync(taskkill, ['/pid', String(pid), '/T', '/F']); });
  const running = await h.record(s);
  assert.ok(Number.isInteger(running.childPid), 'the running record names the CLI child');
  assert.ok(running.childStartedAt, 'and its start time, which proves a later pid is still that process');
  // /F without /T: only the worker dies, as when the user or the OS ends that one process.
  spawnSync(taskkill, ['/pid', String(running.workerPid), '/F']);
  for (let i = 0; i < 50 && alive(running.workerPid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(alive(pids[0]), 'precondition: killing the worker alone leaves the seat running');
  const wait = h.launch(['--wait', s.result, '--max-wait', '10'], { SystemRoot: process.env.SystemRoot });
  assert.equal(wait.status, 1, wait.stdout + wait.stderr);
  assert.match(wait.stdout, /has been stopped/, wait.stderr);
  for (let i = 0; i < 80 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(!pids.some(alive), 'the seat and its child are gone');
});

test('a finished detached run leaves no child pid in result.json', async t => {
  const h = await harness(t);
  const s = await h.seat('clean', { delayMs: 200 });
  assert.equal(h.launch([...s.args, '--detach']).status, 0);
  assert.equal(h.launch(['--wait', s.result, '--max-wait', '90']).status, 0);
  const record = await h.record(s);
  assert.equal(record.status, 'completed');
  assert.ok(!('childPid' in record) && !('childStartToken' in record));
});

test('field run: a session limit given as the error result text is rate-limited with its reset time, and --wait says why', async t => {
  const h = await harness(t);
  const s = await h.seat('session-limit', { isError: true, errors: [], text: "You've hit your session limit · resets 3:30am (America/Chicago)", exitCode: 1 });
  assert.equal(h.launch(s.args).status, 1);
  const record = await h.record(s);
  assertSchema(record);
  assert.equal(record.status, 'rate-limited');
  assert.equal(record.retryAfter, '3:30 AM');
  assert.match(record.retryAfterNote, /the CLI named the zone America\/Chicago/);
  assert.match(record.error, /session limit/);
  const waited = h.launch(['--wait', s.result, '--max-wait', '1']);
  assert.equal(waited.status, 1);
  assert.match(waited.stdout + waited.stderr, /finished with status "rate-limited": .*session limit/);
});
