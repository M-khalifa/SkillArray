import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv } from '../env-filter.mjs';

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

test('buildChildEnv: providerAllowlist keeps a caller-named credential-locator variable (e.g. codex-dispatch.mjs\'s CODEX_HOME)', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    providerAllowlist: ['CODEX_HOME'],
    sourceEnv: { PATH: '/usr/bin', CODEX_HOME: '/custom/.codex' },
  });
  assert.equal(env.CODEX_HOME, '/custom/.codex');
});

test('buildChildEnv: a variable not named in providerAllowlist (and not otherwise allowed) is stripped -- opencode-dispatch.mjs passes no providerAllowlist', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    sourceEnv: { PATH: '/usr/bin', CODEX_HOME: '/should-not-apply-without-providerAllowlist' },
  });
  assert.ok(!('CODEX_HOME' in env));
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

test('buildChildEnv: providerAllowlist entries are matched case-insensitively on win32 too', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'win32',
    providerAllowlist: ['CODEX_HOME'],
    sourceEnv: { SystemRoot: 'C:\\Windows', codex_home: 'C:\\custom\\.codex' },
  });
  assert.equal(env.codex_home, 'C:\\custom\\.codex');
});
