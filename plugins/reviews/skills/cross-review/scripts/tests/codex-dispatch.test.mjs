// Pure-function tests for ../codex-dispatch.mjs. No live codex CLI, no network.
// Run: node --test scripts/tests/codex-dispatch.test.mjs
// (name the file -- the directory form `node --test scripts/tests/` reports a spurious failure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  parsePorcelainRecords,
  parsePorcelainPaths,
  diffTouchedFiles,
  assertWin32Safe,
  checkSessionIdentity,
  parseArgs,
  buildCodexArgs,
  RelayError,
  posixKillTree,
  installSignalForwarding,
  RESULT_REQUIRED_KEYS,
  spawnCli,
  buildChildEnv,
  buildUsageField,
} from '../codex-dispatch.mjs';

// assertWin32Safe only throws on win32; skip the throwing tests elsewhere.
const IS_WIN32 = process.platform === 'win32';

test('parsePorcelainRecords: plain ASCII filenames pass through unchanged', () => {
  const records = parsePorcelainRecords(' M plain.txt\0?? new.txt\0');
  assert.deepEqual(records, [
    { code: ' M', paths: ['plain.txt'] },
    { code: '??', paths: ['new.txt'] },
  ]);
});

test('parsePorcelainRecords: -z output needs no unquoting for spaces/non-ASCII (the whole point of -z)', () => {
  const records = parsePorcelainRecords(' M has space.txt\0?? uni-café.txt\0');
  assert.deepEqual(records, [
    { code: ' M', paths: ['has space.txt'] },
    { code: '??', paths: ['uni-café.txt'] },
  ]);
});

test('parsePorcelainRecords: rename/copy record reassembles from two consecutive NUL fields', () => {
  // Status code is "R  " (R + two spaces), not "R100" with an inline similarity percentage.
  const records = parsePorcelainRecords('R  new name.txt\0old name.txt\0');
  assert.deepEqual(records, [{ code: 'R ', paths: ['new name.txt', 'old name.txt'] }]);
});

test('parsePorcelainRecords: a rename record whose NEW path itself contains " -> " is not corrupted', () => {
  const records = parsePorcelainRecords('R  new -> weird.txt\0old.txt\0');
  assert.deepEqual(records, [{ code: 'R ', paths: ['new -> weird.txt', 'old.txt'] }]);
});

test('parsePorcelainRecords: a rename record whose OLD path itself contains " -> " is not corrupted', () => {
  const records = parsePorcelainRecords('R  new.txt\0old -> weird.txt\0');
  assert.deepEqual(records, [{ code: 'R ', paths: ['new.txt', 'old -> weird.txt'] }]);
});

test('parsePorcelainRecords: a PLAIN (non-rename) record with " -> " in the filename is not misread as a rename', () => {
  const records = parsePorcelainRecords(' M a -> b.txt\0');
  assert.deepEqual(records, [{ code: ' M', paths: ['a -> b.txt'] }]);
});

test('parsePorcelainPaths: extracts both sides of a rename', () => {
  const paths = parsePorcelainPaths({ code: 'R ', paths: ['new name.txt', 'old name.txt'] });
  assert.deepEqual([...paths].sort(), ['new name.txt', 'old name.txt']);
});

test('parsePorcelainPaths: extracts a plain modified path', () => {
  const paths = parsePorcelainPaths({ code: ' M', paths: ['has space.txt'] });
  assert.deepEqual([...paths], ['has space.txt']);
});

test('diffTouchedFiles: detects a newly untracked file', () => {
  const before = ' M plain.txt\0';
  const after = ' M plain.txt\0?? new.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['new.txt']);
});

test('diffTouchedFiles: detects a status-code change on the same path (" M" -> "MM")', () => {
  const before = ' M plain.txt\0';
  const after = 'MM plain.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['plain.txt']);
});

test('diffTouchedFiles: a file with a space in its name reports cleanly, not mangled', () => {
  const before = '';
  const after = '?? has space.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['has space.txt']);
});

test('diffTouchedFiles: a rename whose path contains " -> " reports the real filenames, not split fragments', () => {
  const before = '';
  const after = 'R  new -> weird.txt\0old.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['new -> weird.txt', 'old.txt']);
});

test('diffTouchedFiles: a plain modify with " -> " in the filename reports the real filename whole', () => {
  const before = '';
  const after = ' M a -> b.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['a -> b.txt']);
});

test('diffTouchedFiles: known limitation — a file dirty before AND modified again during the run can be under-reported', () => {
  const before = ' M plain.txt\0';
  const after = ' M plain.txt\0'; // same status code both times, despite a real edit
  assert.deepEqual(diffTouchedFiles(before, after), []);
});

test('checkSessionIdentity: a fresh dispatch with a confirmed thread id is sound', () => {
  assert.equal(checkSessionIdentity({ session: null, observedThreadId: 'abc-123' }), null);
});

test('checkSessionIdentity: a resume where the observed id matches the requested session is sound', () => {
  assert.equal(checkSessionIdentity({ session: 'abc-123', observedThreadId: 'abc-123' }), null);
});

test('checkSessionIdentity: a fresh dispatch with NO thread id observed fails closed', () => {
  const err = checkSessionIdentity({ session: null, observedThreadId: null });
  assert.match(err, /no thread\.started event was observed/);
});

test('checkSessionIdentity: a resume with NO thread id observed fails closed (does not silently retain the request)', () => {
  const err = checkSessionIdentity({ session: 'requested-id', observedThreadId: null });
  assert.match(err, /requested session "requested-id"/);
  assert.match(err, /no thread\.started event was observed/);
});

test('checkSessionIdentity: a resume where the observed id does NOT match the requested session fails closed', () => {
  const err = checkSessionIdentity({ session: 'requested-id', observedThreadId: 'different-id' });
  assert.match(err, /session mismatch/);
  assert.match(err, /requested "requested-id"/);
  assert.match(err, /observed thread_id "different-id"/);
});

test('assertWin32Safe: rejects a trailing backslash (escapes the closing quote, merges the next argv entry) (platform injected, runs on every OS)', () => {
  assert.throws(() => assertWin32Safe('C:\\repo\\', { platform: 'win32' }), /unsafe to pass through cmd\.exe/);
});

test('assertWin32Safe: rejects an embedded double quote (can re-expose shell metacharacters) (platform injected, runs on every OS)', () => {
  assert.throws(() => assertWin32Safe('x" & echo INJECTED & rem "', { platform: 'win32' }), /unsafe to pass through cmd\.exe/);
});

test('assertWin32Safe: rejects a percent sign (cmd.exe expands %VAR% inside double quotes) (platform injected, runs on every OS)', () => {
  assert.throws(() => assertWin32Safe('before %USERNAME% after', { platform: 'win32' }), /unsafe to pass through cmd\.exe/);
});

test('assertWin32Safe: the same unsafe characters are not rejected on a non-win32 platform (the guard is win32-specific)', () => {
  assert.doesNotThrow(() => assertWin32Safe('before %USERNAME% after', { platform: 'linux' }));
});

test('assertWin32Safe: accepts an ordinary path with no special characters', () => {
  // Not skipped off win32: no-throw is meaningful on every platform.
  assert.doesNotThrow(() => assertWin32Safe('C:\\Users\\me\\repo', { platform: 'win32' }));
});

test('assertWin32Safe: accepts a path with a space (not one of the rejected characters)', () => {
  assert.doesNotThrow(() => assertWin32Safe('C:\\dir with space\\repo', { platform: 'win32' }));
});

test('assertWin32Safe: on a real, uninjected call, follows the actual process platform', () => {
  if (IS_WIN32) {
    assert.throws(() => assertWin32Safe('x" & echo injected'), /unsafe to pass through cmd\.exe/);
  } else {
    assert.doesNotThrow(() => assertWin32Safe('x" & echo injected'));
  }
});

test('parseArgs: a trailing --session with no value is rejected, not silently treated as a fresh dispatch', () => {
  // A bare trailing --session must error, not resolve to undefined and fall into
  // the fresh-dispatch branch, which would silently defeat Phase 2's resume discipline.
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--cd', '.', '--session']),
    (err) => err instanceof RelayError && /--session requires a value/.test(err.message)
  );
});

test('parseArgs: --session followed immediately by another flag is rejected, not consumed as the value', () => {
  // `--session --cd /tmp` must not read '--cd' as the session value and then
  // consume the real --cd on the next iteration, corrupting both.
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--session', '--cd', '.']),
    (err) => err instanceof RelayError && /--session requires a value/.test(err.message)
  );
});

test('parseArgs: a trailing --brief/--cd/--sandbox with no value is rejected the same way', () => {
  assert.throws(() => parseArgs(['--brief']), /--brief requires a value/);
  assert.throws(() => parseArgs(['--brief', 'b.txt', '--cd']), /--cd requires a value/);
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--cd', '.', '--sandbox']),
    /--sandbox requires a value/
  );
});

test('parseArgs: a well-formed --session with a real value still parses correctly', () => {
  const args = parseArgs(['--brief', 'b.txt', '--cd', '.', '--session', 'thread-123']);
  assert.equal(args.session, 'thread-123');
});

test('parseArgs: --isolate is rejected with a message pointing at opencode-dispatch.mjs and --sandbox read-only, not a bare "unrecognized argument"', () => {
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--cd', '.', '--isolate']),
    /opencode-dispatch\.mjs only.*--sandbox read-only/s
  );
});

test('parseArgs: sandbox defaults to read-only when --sandbox is omitted', () => {
  const args = parseArgs(['--brief', 'b.txt', '--cd', '.']);
  assert.equal(args.sandbox, 'read-only');
});

test('parseArgs: --web defaults to false and is a boolean flag with no value', () => {
  const withoutWeb = parseArgs(['--brief', 'b.txt', '--cd', '.']);
  assert.equal(withoutWeb.web, false);
  const withWeb = parseArgs(['--brief', 'b.txt', '--cd', '.', '--web']);
  assert.equal(withWeb.web, true);
});

test('model and effort options parse and reject missing or unsafe values', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs([...common, '--model', 'gpt-test', '--effort', 'high']);
  assert.equal(config.model, 'gpt-test');
  assert.equal(config.effort, 'high');
  for (const flag of ['--model', '--effort']) {
    assert.throws(() => parseArgs([...common, flag]), /requires a value/);
    assert.throws(() => parseArgs([...common, flag, '']), /requires a value/);
    assert.throws(() => parseArgs([...common, flag, '--session', 'x']), /requires a value/);
  }
  assert.throws(() => parseArgs([...common, '--model', 'x & echo bad']), /model ID/);
  assert.throws(() => parseArgs([...common, '--effort', 'high"']), /level token/);
  assert.throws(() => parseArgs([...common, '--effort', 'default']), /omit/);
});

test('parseArgs: --timeout defaults to a provisional non-null value when omitted, never unlimited by omission', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs(common);
  assert.equal(typeof config.timeout, 'number');
  assert.ok(config.timeout > 0, 'the default must be a positive bound, not 0/unlimited');
});

test('parseArgs: --timeout 0 means explicitly unlimited, distinct from omitting the flag', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs([...common, '--timeout', '0']);
  assert.equal(config.timeout, 0);
});

test('parseArgs: --timeout accepts a whole number (including 0) and rejects non-numeric, fractional, or negative-looking values', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.equal(parseArgs([...common, '--timeout', '45']).timeout, 45);
  assert.throws(() => parseArgs([...common, '--timeout', 'abc']), /whole number of seconds/);
  assert.throws(() => parseArgs([...common, '--timeout', '5.5']), /whole number of seconds/);
  // A value starting with "-" is consumed as the next flag by takeValue, not
  // as a negative number -- this is existing CLI-parsing behavior, exercised
  // here as "requires a value" rather than the numeric-format error.
  assert.throws(() => parseArgs([...common, '--timeout', '-5']), /requires a value/);
});

test('fresh and resumed argument vectors forward selections without resume sandbox flags', () => {
  const options = { cd: '/target', sandbox: 'read-only', model: 'gpt-test', effort: 'high' };
  assert.deepEqual(buildCodexArgs(options), [
    'exec', '-C', '/target', '-s', 'read-only', '--model', 'gpt-test',
    '-c', 'model_reasoning_effort=high', '--json', '-',
  ]);
  assert.deepEqual(buildCodexArgs({ ...options, session: 'thread-123' }), [
    'exec', 'resume', 'thread-123', '--model', 'gpt-test',
    '-c', 'model_reasoning_effort=high', '--json', '-',
  ]);
  const defaults = buildCodexArgs({ cd: '.', sandbox: 'read-only' });
  assert.equal(defaults.includes('--model'), false);
  assert.equal(defaults.includes('-c'), false);
});

test('buildCodexArgs: --web prepends --search BEFORE "exec" (a global codex flag, rejected if placed after), on both fresh and resumed argv shapes', () => {
  const fresh = buildCodexArgs({ cd: '/target', sandbox: 'read-only', web: true });
  assert.deepEqual(fresh, ['--search', 'exec', '-C', '/target', '-s', 'read-only', '--json', '-']);
  assert.equal(fresh[0], '--search', '--search must be argv[0], ahead of "exec"');
  assert.equal(fresh.indexOf('--search') < fresh.indexOf('exec'), true);

  const resumed = buildCodexArgs({ cd: '/target', sandbox: 'read-only', session: 'thread-123', web: true });
  assert.deepEqual(resumed, ['--search', 'exec', 'resume', 'thread-123', '--json', '-']);
  assert.equal(resumed.indexOf('--search') < resumed.indexOf('exec'), true);

  const withoutWeb = buildCodexArgs({ cd: '/target', sandbox: 'read-only' });
  assert.equal(withoutWeb.includes('--search'), false);
});

test('spawnCli: the POSIX branch passes detached:true and shell:false to spawn(), the load-bearing options for posixKillTree\'s process-group kill', () => {
  let captured = null;
  const fakeSpawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return new EventEmitter();
  };
  spawnCli('codex', ['exec'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'linux' });
  assert.equal(captured.cmd, 'codex');
  assert.deepEqual(captured.args, ['exec']);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.shell, false);
  assert.equal(captured.opts.cwd, '/tmp');
});

test('spawnCli: the win32 branch runs under a shell and does not set detached', () => {
  let captured = null;
  const fakeSpawn = (cmdLine, opts) => {
    captured = { cmdLine, opts };
    return new EventEmitter();
  };
  spawnCli('codex', ['exec'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'win32' });
  assert.match(captured.cmdLine, /"codex" "exec"/);
  assert.equal(captured.opts.shell, true);
  assert.equal(captured.opts.detached, undefined);
});

test('spawnCli: A3=B12 -- an injected win32 platform actually reaches assertWin32Safe, so this guard is testable on any OS', () => {
  const fakeSpawn = () => new EventEmitter();
  assert.throws(
    () => spawnCli('codex', ['x" & echo injected'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'win32' }),
    /unsafe to pass/
  );
  assert.doesNotThrow(
    () => spawnCli('codex', ['x" & echo injected'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'linux' })
  );
});

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

test('posixKillTree: a child that never exits gets SIGTERM then SIGKILL, both targeting the process group', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => calls.push([pid, sig]);
  await posixKillTree(child, { kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
});

test('posixKillTree: a child that exits after SIGTERM never gets SIGKILL', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 'SIGTERM') setImmediate(() => child.emit('exit', null));
  };
  await posixKillTree(child, { kill, escalateMs: 50 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('posixKillTree: SIGKILL still fires even when the fake kill sets child.killed like the real one does (the exact regression)', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    child.killed = true;
  };
  await posixKillTree(child, { kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
});

test('posixKillTree: a pid that is already gone (ESRCH) is not an error', async () => {
  const child = fakeChild();
  const kill = () => { const err = new Error('no such process'); err.code = 'ESRCH'; throw err; };
  await assert.doesNotReject(() => posixKillTree(child, { kill, escalateMs: 1 }));
});

test('installSignalForwarding: SIGINT and SIGTERM trigger killTree on the child and exit with the matching code', async () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const proc = new EventEmitter();
    const child = fakeChild();
    const killed = [];
    const exited = [];
    const killTreeFn = (c) => { killed.push(c); return Promise.resolve(); };
    const exit = (c) => exited.push(c);
    installSignalForwarding(child, { proc, killTreeFn, exit });
    proc.emit(sig);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(killed, [child]);
    assert.deepEqual(exited, [code]);
  }
});

test('installSignalForwarding: uninstall removes the listeners, a later signal does nothing', async () => {
  const proc = new EventEmitter();
  const child = fakeChild();
  const killed = [];
  const uninstall = installSignalForwarding(child, {
    proc, killTreeFn: (c) => { killed.push(c); return Promise.resolve(); }, exit: () => {},
  });
  uninstall();
  proc.emit('SIGINT');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(killed, []);
});

test('RESULT_REQUIRED_KEYS: codex and opencode dispatchers share the same result.json schema (minus their own session-id key)', async () => {
  const { RESULT_REQUIRED_KEYS: opencodeKeys } = await import('../opencode-dispatch.mjs');
  assert.deepEqual([...RESULT_REQUIRED_KEYS].sort(), [...opencodeKeys].sort());
});

test('buildChildEnv: envMode "inherit" returns undefined, matching Node spawn()\'s own full-inheritance default', () => {
  const env = buildChildEnv({ envMode: 'inherit', sourceEnv: { PATH: '/x', AWS_SECRET_ACCESS_KEY: 'super-secret' } });
  assert.equal(env, undefined);
});

test('buildChildEnv: envMode "filtered" strips a secret-shaped variable that is not on the allowlist', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    sourceEnv: { PATH: '/usr/bin', HOME: '/home/x', AWS_SECRET_ACCESS_KEY: 'super-secret', GITHUB_TOKEN: 'ghp_x', DB_PASSWORD: 'hunter2' },
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
  assert.ok(!('AWS_SECRET_ACCESS_KEY' in env), 'a secret-shaped var not on the allowlist must be stripped');
  assert.ok(!('GITHUB_TOKEN' in env), 'a secret-shaped var not on the allowlist must be stripped');
  assert.ok(!('DB_PASSWORD' in env), 'a secret-shaped var not on the allowlist must be stripped');
});

test('buildChildEnv: envMode "filtered" keeps CODEX_HOME, codex\'s own credential-locator variable', () => {
  const env = buildChildEnv({ envMode: 'filtered', platform: 'linux', sourceEnv: { PATH: '/usr/bin', CODEX_HOME: '/custom/.codex' } });
  assert.equal(env.CODEX_HOME, '/custom/.codex');
});

test('buildChildEnv: envMode "filtered" on POSIX keeps LC_*/XDG_* prefixed variables by prefix match, not just exact allowlist entries', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    sourceEnv: { PATH: '/usr/bin', LC_ALL: 'en_US.UTF-8', XDG_DATA_HOME: '/home/x/.local/share', RANDOM_VAR: 'not-allowed' },
  });
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
  assert.equal(env.XDG_DATA_HOME, '/home/x/.local/share');
  assert.ok(!('RANDOM_VAR' in env));
});

test('buildChildEnv: envMode "filtered" on win32 uses the win32 allowlist, not the POSIX one (no LC_/XDG_ prefix matching)', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'win32',
    sourceEnv: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', LC_ALL: 'en_US.UTF-8', HOME: '/should-not-apply-on-win32' },
  });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.USERPROFILE, 'C:\\Users\\x');
  assert.ok(!('LC_ALL' in env), 'POSIX-only prefix matching must not apply on win32');
  assert.ok(!('HOME' in env), 'HOME is POSIX-only; win32 uses USERPROFILE');
});

test('buildChildEnv: envPassthrough adds an explicitly named variable that the base allowlist does not cover', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    envPassthrough: ['MY_PROVIDER_API_KEY'],
    sourceEnv: { PATH: '/usr/bin', MY_PROVIDER_API_KEY: 'sk-real-key', OTHER_SECRET: 'not-passed' },
  });
  assert.equal(env.MY_PROVIDER_API_KEY, 'sk-real-key');
  assert.ok(!('OTHER_SECRET' in env));
});

test('buildChildEnv: an env var with value undefined is never included, filtered or inherit-by-name', () => {
  const sourceEnv = { PATH: '/usr/bin' };
  Object.defineProperty(sourceEnv, 'WEIRD', { value: undefined, enumerable: true });
  const env = buildChildEnv({ envMode: 'filtered', platform: 'linux', sourceEnv });
  assert.ok(!('WEIRD' in env));
});

test('buildChildEnv: envMode "filtered" on win32 matches allowlisted names case-insensitively (cmd.exe/PowerShell expose "Path", not "PATH")', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'win32',
    sourceEnv: { Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows' },
  });
  assert.equal(env.Path, 'C:\\Windows\\system32', 'a differently-cased allowlisted name must still pass through on win32');
});

test('parseArgs: --env-mode defaults to "filtered", the safe-by-default choice', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.equal(parseArgs(common).envMode, 'filtered');
});

test('parseArgs: --env-mode accepts "inherit" and rejects anything else', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.equal(parseArgs([...common, '--env-mode', 'inherit']).envMode, 'inherit');
  assert.throws(() => parseArgs([...common, '--env-mode', 'yolo']), /must be "filtered" or "inherit"/);
});

test('parseArgs: --env-passthrough splits a comma-separated list and rejects an invalid variable name', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs([...common, '--env-passthrough', 'FOO_KEY, BAR_TOKEN']);
  assert.deepEqual(config.envPassthrough, ['FOO_KEY', 'BAR_TOKEN']);
  assert.throws(() => parseArgs([...common, '--env-passthrough', '123BAD']), /not a valid environment variable name/);
  assert.throws(() => parseArgs([...common, '--env-passthrough', 'has-a-dash']), /not a valid environment variable name/);
});

test('buildUsageField: maps a real turn.completed.usage event to the nested usage shape with source "provider"', () => {
  // Exact shape captured from a live "codex exec --json --sandbox read-only" run.
  const rawUsage = {
    input_tokens: 26076,
    cached_input_tokens: 8960,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_output_tokens: 0,
  };
  assert.deepEqual(buildUsageField(rawUsage), {
    input_tokens: 26076,
    cached_input_tokens: 8960,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    source: 'provider',
    raw: rawUsage,
  });
});

test('buildUsageField: no turn.completed event observed yields {source: "unavailable"}, never a fabricated value', () => {
  assert.deepEqual(buildUsageField(null), { source: 'unavailable' });
});

test('buildUsageField: never assumes a relationship between cached_input_tokens and input_tokens -- both are passed through verbatim, no derived/combined total', () => {
  const rawUsage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };
  const field = buildUsageField(rawUsage);
  assert.equal(field.input_tokens, 100, 'input_tokens must be the raw provider value, not reduced by cached_input_tokens');
  assert.equal(field.cached_input_tokens, 40, 'cached_input_tokens must be the raw provider value, not added to input_tokens');
  assert.ok(!('derived_total_input_tokens_estimate' in field), 'this dispatcher computes no derived total -- that is a separate, explicitly-labeled downstream concern');
});

test('estimated_cost_usd is always null from buildUsageField: no price table is embedded in this dispatcher', () => {
  assert.equal(buildUsageField({ input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }).estimated_cost_usd, null);
  assert.equal(buildUsageField(null).estimated_cost_usd, undefined, '{source: "unavailable"} carries no numeric fields at all, not even a null cost');
});
