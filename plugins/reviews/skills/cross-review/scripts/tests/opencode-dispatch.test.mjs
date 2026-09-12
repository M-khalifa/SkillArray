// Pure-function tests for ../opencode-dispatch.mjs. No live OpenCode CLI, no network.
// Run: node --test scripts/tests/opencode-dispatch.test.mjs
// (name the file -- the directory form `node --test scripts/tests/` reports a spurious failure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  parsePorcelainRecords,
  parsePorcelainPaths,
  diffTouchedFiles,
  assertWin32Safe,
  buildOpencodeArgs,
  checkSessionIdentity,
  parseArgs,
  RelayError,
  OPENCODE_SPAWN_STDIO,
} from '../opencode-dispatch.mjs';

const IS_WIN32 = process.platform === 'win32';

test('parseArgs: a missing --session/--model/--variant operand is rejected, never silently dropped', () => {
  // Without the takeValue() guard, a trailing `--session` parsed to undefined and the dispatch
  // silently became a fresh run; `--model --variant high` consumed '--variant' as the model.
  const common = ['--brief', 'b.txt', '--cd', '.'];
  for (const flag of ['--session', '--model', '--variant', '--brief', '--cd']) {
    assert.throws(
      () => parseArgs([...common, flag]),
      (err) => err instanceof RelayError && err.message === `${flag} requires a value`
    );
    assert.throws(() => parseArgs([...common, flag, '']), /requires a value/);
    assert.throws(() => parseArgs([...common, flag, '--format']), /requires a value/);
  }
  const ok = parseArgs([...common, '--session', 'ses_1', '--model', 'p/m', '--variant', 'high']);
  assert.deepEqual([ok.session, ok.model, ok.variant], ['ses_1', 'p/m', 'high']);
});

test('parseArgs: --effort is accepted as an alias for --variant', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const ok = parseArgs([...common, '--effort', 'high']);
  assert.equal(ok.variant, 'high');
});

test('parseArgs: --model and --variant reject shell metacharacters and short-flag injection', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.throws(() => parseArgs([...common, '--model', 'x; rm -rf /']), /model ID, not a shell expression/);
  assert.throws(() => parseArgs([...common, '--variant', '; whoami']), /level token/);
  assert.throws(
    () => parseArgs([...common, '--model', '-s']),
    (err) => err instanceof RelayError && err.message === '--model requires a value'
  );
  assert.throws(
    () => parseArgs([...common, '--variant', '-h']),
    (err) => err instanceof RelayError && err.message === '--variant requires a value'
  );
  const ok = parseArgs([...common, '--model', 'anthropic/claude-opus-5', '--variant', 'high']);
  assert.deepEqual([ok.model, ok.variant], ['anthropic/claude-opus-5', 'high']);
});

test('buildOpencodeArgs: fresh dispatch attaches brief and requests JSON', () => {
  assert.deepEqual(
    buildOpencodeArgs({
      briefPath: 'C:\\briefs\\review.txt',
      cd: 'C:\\repo',
      session: null,
      model: null,
      variant: null,
    }),
    [
      'run',
      'Read the attached brief file and follow its instructions exactly.',
      '-f',
      'C:\\briefs\\review.txt',
      '--dir',
      'C:\\repo',
      '--format',
      'json',
    ]
  );
});

test('buildOpencodeArgs: resume preserves dir and forwards model/variant', () => {
  assert.deepEqual(
    buildOpencodeArgs({
      briefPath: 'brief.txt',
      cd: 'repo',
      session: 'ses_123',
      model: 'anthropic/claude-opus-5',
      variant: 'high',
    }),
    [
      'run',
      'Read the attached brief file and follow its instructions exactly.',
      '-f',
      'brief.txt',
      '--dir',
      'repo',
      '-s',
      'ses_123',
      '-m',
      'anthropic/claude-opus-5',
      '--variant',
      'high',
      '--format',
      'json',
    ]
  );
});

test('parsePorcelainRecords: plain and rename records retain exact paths', () => {
  assert.deepEqual(parsePorcelainRecords(' M plain.txt\0R  new -> name.txt\0old.txt\0'), [
    { code: ' M', paths: ['plain.txt'] },
    { code: 'R ', paths: ['new -> name.txt', 'old.txt'] },
  ]);
});

test('parsePorcelainPaths: rename exposes both paths', () => {
  assert.deepEqual(
    [...parsePorcelainPaths({ code: 'R ', paths: ['new.txt', 'old.txt'] })].sort(),
    ['new.txt', 'old.txt']
  );
});

test('diffTouchedFiles: reports new files and status changes', () => {
  const before = ' M changed.txt\0';
  const after = 'MM changed.txt\0?? new.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['changed.txt', 'new.txt']);
});

test('checkSessionIdentity: fresh and matching resume sessions pass', () => {
  assert.equal(checkSessionIdentity({ session: null, observedSessionId: 'ses_123' }), null);
  assert.equal(
    checkSessionIdentity({ session: 'ses_123', observedSessionId: 'ses_123' }),
    null
  );
});

test('checkSessionIdentity: absent and mismatched session IDs fail closed', () => {
  assert.match(
    checkSessionIdentity({ session: null, observedSessionId: null }),
    /no sessionID was observed/
  );
  assert.match(
    checkSessionIdentity({ session: 'ses_123', observedSessionId: 'ses_other' }),
    /session mismatch/
  );
});

test(
  'assertWin32Safe: rejects shell-breaking characters on Windows',
  { skip: !IS_WIN32 },
  () => {
    assert.throws(() => assertWin32Safe('before %USERNAME% after'), /unsafe to pass/);
    assert.throws(() => assertWin32Safe('C:\\repo\\'), /unsafe to pass/);
    assert.throws(() => assertWin32Safe('x" & echo injected'), /unsafe to pass/);
  }
);

test('assertWin32Safe: accepts ordinary paths and spaces', () => {
  assert.doesNotThrow(() => assertWin32Safe('C:\\dir with space\\repo'));
});

test('OPENCODE_SPAWN_STDIO: stdin is "ignore", not the pipe default', () => {
  // Cheap but weak on its own: someone could rename this constant and inline
  // a different value at the call site without this test noticing. The real
  // guard is the behavioral test below.
  assert.deepEqual(OPENCODE_SPAWN_STDIO, ['ignore', 'pipe', 'pipe']);
});

test(
  'OPENCODE_SPAWN_STDIO regression: an open, never-ended stdin pipe hangs a ' +
    'stdin-EOF-waiting process; this exact stdio option is what prevents that',
  { timeout: 15000 },
  async () => {
    // Stands in for `opencode run`: a tiny Node one-liner that reads stdin to
    // EOF before printing anything and exiting. This isn't simulating OpenCode's
    // CLI, it's proving OPENCODE_SPAWN_STDIO changes whether such a process
    // ever receives EOF.
    const stdinWaiterScript =
      'process.stdin.resume();' +
      'process.stdin.on("end", () => { process.stdout.write("done"); process.exit(0); });';

    function run(stdio) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', stdinWaiterScript], { stdio });
        let out = '';
        if (child.stdout) child.stdout.on('data', (d) => (out += d.toString()));
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.on('close', () => finish({ closed: true, out }));
        // A real hang means no 'close' event ever fires. Use a short timeout
        // instead of the full suite timeout so this fails with a legible
        // message instead of a generic one.
        setTimeout(() => {
          if (!settled) {
            child.kill();
            finish({ closed: false, out });
          }
        }, 3000);
      });
    }

    // The bug: default stdio (an open, never-ended stdin pipe) means the child
    // never sees EOF, so it never prints "done" or closes within the window.
    const withDefaultStdio = await run(['pipe', 'pipe', 'pipe']);
    assert.equal(
      withDefaultStdio.closed,
      false,
      'expected the default-stdio case to still be hung after 3s (reproducing the original bug) — ' +
        'if this now closes, the reproduction itself has stopped working and this test needs review'
    );

    // The fix: OPENCODE_SPAWN_STDIO's stdin is 'ignore', so Node closes stdin
    // immediately and a stdin-EOF-waiting process proceeds right away.
    const withFixStdio = await run(OPENCODE_SPAWN_STDIO);
    assert.equal(withFixStdio.closed, true, 'expected OPENCODE_SPAWN_STDIO to let the process complete');
    assert.equal(withFixStdio.out, 'done');
  }
);
