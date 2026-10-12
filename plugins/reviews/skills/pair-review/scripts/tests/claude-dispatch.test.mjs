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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review adapter '));
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
    cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000,
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
  const outputPermission = process.platform === 'win32'
    ? '//' + inspect.folder[0].toLowerCase() + inspect.folder.slice(2).replaceAll('\\', '/')
    : '/' + inspect.folder;
  assert.deepEqual(observed.argv, [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-fixture',
    '--effort', 'high', '--resume', 'phase1-session', '--permission-mode', 'dontAsk', '--restricted',
    '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', 'Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch',
    '--add-dir', inspect.folder, '--add-dir', source,
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash', 'Edit(' + outputPermission + '/**)', 'WebFetch', 'WebSearch',
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
  assert.deepEqual(argv.flatMap((value, index) => value === '--add-dir' ? [argv[index + 1]] : []), [output, source1, source2]);
  assert.equal(argv.filter(value => value.startsWith('Edit(')).length, 1);
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
      const run = h.launch([...s.args, '--env-mode', envMode, '--env-passthrough', Object.keys(vars).join(','),
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
      NODE_EXTRA_CA_CERTS: '/cert', SSL_CERT_FILE: '/cert', SSL_CERT_DIR: '/certs', REQUESTS_CA_BUNDLE: '/cert', CURL_CA_BUNDLE: '/cert',
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
    assert.equal(observed.cwd.toLowerCase(), record.worktreePath.toLowerCase());
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
      await fs.writeFile(job, JSON.stringify({ cwd: h.dir, env: { PATH: h.env.PATH }, argv: [...s.args, '--env-mode', envMode, '--env-passthrough', Object.keys(vars).join(','), ...(useApiKey ? ['--use-api-key'] : [])] }));
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
    const wait = h.launch(['--wait', s.result, '--max-wait', '15']);
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
  assert.equal(h.launch(['--wait', s.result, '--max-wait', '1']).status, 3);
  await fs.writeFile(s.result, JSON.stringify({ status: 'error' }));
  assert.equal(h.launch(['--wait', s.result]).status, 1);
  assert.equal(h.launch(['--wait-retry', s.result]).status, 2);
  const clock = date => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  await fs.writeFile(s.result, JSON.stringify({ status: 'rate-limited', retryAfter: clock(new Date(Date.now() - 120000)), sessionId: 'fixture-session' }));
  assert.equal(h.launch(['--wait-retry', s.result]).status, 0);
  await fs.writeFile(s.result, JSON.stringify({ status: 'rate-limited', retryAfter: clock(new Date(Date.now() + 300000)) }));
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
    if (process.platform !== 'win32') {
      try { if ((await fs.readFile('/proc/' + pid + '/stat', 'utf8')).split(' ')[2] === 'Z') return; } catch (error) { if (error.code === 'ENOENT') return; }
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
      const run = h.launch([...s.args, '--timeout', '2']);
      assert.equal(run.status, 1, run.stderr);
      const record = await h.record(s);
      assertSchema(record);
      assert.equal(record.status, 'timed-out');
      assert.equal(record.sessionId, 'fixture-session');
      assert.match(record.error, /timeout 2s/);
      const pids = await readPids(pidFile);
      assert.equal(pids.length, 2, 'fake child and descendant started');
      for (const pid of pids) await assertDead(pid);
    } finally {
      killFixturePids(await readPids(pidFile));
    }
  }
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
