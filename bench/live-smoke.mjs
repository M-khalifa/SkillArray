// Live-provider smoke tests. Design: docs/design/live-smoke-tests.md.
//
// Safe by default: every test is skipped unless SKILLARRAY_LIVE_SMOKE=1 is
// explicitly set by a human who has real provider credentials configured.
// This file is structurally never picked up by CI's mocked test runs and
// spends zero API budget when run as part of a normal `node --test` sweep.
//
// To actually run these, a human must implement each test body against
// real CLIs (codex, opencode, a real Claude Code harness) and a fixture
// repository under bench/fixtures/ (not yet built). This file is a
// reviewable skeleton, not a working smoke suite yet.

import { test } from 'node:test';

const LIVE = process.env.SKILLARRAY_LIVE_SMOKE === '1';

test('Claude seat invocation returns a real Phase 1 finding shape', { skip: !LIVE }, async () => {
  throw new Error('not implemented: dispatch a real pair-review Claude seat against bench/fixtures/ and assert Phase 1 output shape');
});

test('Codex invocation matches codex-dispatch.mjs\'s expected output contract', { skip: !LIVE }, async () => {
  throw new Error('not implemented: run codex-dispatch.mjs against the real codex CLI and confirm thread-started/final-message parsing still matches');
});

test('OpenCode-provider path matches opencode-dispatch.mjs\'s expected output contract', { skip: !LIVE }, async () => {
  throw new Error('not implemented: run opencode-dispatch.mjs against a configured real OpenCode provider');
});

test('codex-dispatch.mjs --session resumes a prior thread rather than starting fresh', { skip: !LIVE }, async () => {
  throw new Error('not implemented: start a session, capture its threadId, resume it, confirm continuity');
});

test('blind-relabel.mjs relabel/scan handles real reviewer output without false-positive or false-negative identity leaks', { skip: !LIVE }, async () => {
  throw new Error('not implemented: run scan against real (not fixture-crafted) reviewer text');
});

test('fresh-context auditor synthesis and translate produce a schema-valid findings.json from a real run', { skip: !LIVE }, async () => {
  throw new Error('not implemented: full end-to-end run against bench/fixtures/, assert translate exits 0');
});
