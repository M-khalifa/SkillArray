import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertWin32Safe, winQuote, posixKillTree, killTree, spawnCli } from '../spawn-utils.mjs';

const IS_WIN32 = process.platform === 'win32';

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

test('winQuote: wraps in double quotes and escapes an embedded double quote', () => {
  assert.equal(winQuote('plain'), '"plain"');
  assert.equal(winQuote('has "quote"'), '"has \\"quote\\""');
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

test('spawnCli: an injected win32 platform actually reaches assertWin32Safe, so this guard is testable on any OS', () => {
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

test('posixKillTree: a pid that is already gone (ESRCH) is not an error', async () => {
  const child = fakeChild();
  const kill = () => { const err = new Error('no such process'); err.code = 'ESRCH'; throw err; };
  await assert.doesNotReject(() => posixKillTree(child, { kill, escalateMs: 1 }));
});

test('killTree: on a non-win32 platform, delegates to posixKillTree (SIGTERM then SIGKILL, both forwarded)', async () => {
  const calls = [];
  const child = fakeChild();
  // Inject a recording fake `kill` -- never send a real signal to an
  // arbitrary pid here: on a Linux/macOS CI runner, -4242 could coincide
  // with a real process group, and posixKillTree's default `kill` calls
  // the real process.kill(-pid, sig) unless overridden.
  const kill = (pid, sig) => calls.push([pid, sig]);
  await killTree(child, { platform: 'linux', kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
});

test('killTree: a log callback receives a message on taskkill failure (win32 branch)', async () => {
  // Exercises killTree's win32 branch without a real taskkill.exe: an invalid
  // pid still spawns taskkill, which will exit non-zero rather than error, so
  // this asserts killTree resolves rather than hangs -- the log callback
  // itself is exercised in codex-dispatch.mjs's/opencode-dispatch.mjs's own
  // integration-level tests, which run on real Windows CI.
  if (!IS_WIN32) return; // taskkill.exe only exists on win32
  const child = fakeChild(999999999);
  await assert.doesNotReject(() => killTree(child, { platform: 'win32', log: () => {} }));
});
