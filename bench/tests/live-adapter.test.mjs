// Provider-independent tests for the PURE functions in ../adapters/live.mjs
// (parseFindingsBlock, renderBrief, mapClaudeCliResult) -- no spawned
// process, no provider credentials, no network. The spawn-based runArm
// itself is exercised only by bench/live-smoke.mjs under
// SKILLARRAY_LIVE_SMOKE=1, never here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFindingsBlock, renderBrief, mapClaudeCliResult, runArm } from '../adapters/live.mjs';

async function withTmpDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-adapter-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseFindingsBlock: a well-formed fenced json block with findings parses cleanly', () => {
  const text = [
    'Here is my review.',
    '',
    '```json',
    '{"findings": [{"id": "F1", "location": "src/x.py:10", "severity": "HIGH", "evidence": ["bad thing"]}]}',
    '```',
  ].join('\n');
  const result = parseFindingsBlock(text);
  assert.equal(result.error, undefined);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, 'F1');
});

test('parseFindingsBlock: an empty findings array is valid (reviewer found nothing)', () => {
  const text = '```json\n{"findings": []}\n```';
  const result = parseFindingsBlock(text);
  assert.deepEqual(result.findings, []);
});

test('parseFindingsBlock: no fenced json block at all is reported as an error, never silently empty', () => {
  const result = parseFindingsBlock('I reviewed the code and found nothing worth a structured block.');
  assert.ok(result.error);
  assert.equal(result.findings, undefined);
});

test('parseFindingsBlock: a fenced block that is not valid JSON is reported as an error', () => {
  const result = parseFindingsBlock('```json\n{not valid json\n```');
  assert.ok(result.error);
});

test('parseFindingsBlock: a fenced block missing the "findings" array is reported as an error', () => {
  const result = parseFindingsBlock('```json\n{"other_field": true}\n```');
  assert.ok(result.error);
});

test('parseFindingsBlock: a finding with no string id is reported as an error', () => {
  const result = parseFindingsBlock('```json\n{"findings": [{"location": "x.py"}]}\n```');
  assert.ok(result.error);
  assert.match(result.error, /id/);
});

test('parseFindingsBlock: empty/non-string input is reported as an error, never throws', () => {
  assert.ok(parseFindingsBlock('').error);
  assert.ok(parseFindingsBlock(null).error);
  assert.ok(parseFindingsBlock(undefined).error);
});

test('renderBrief: throws when packet.case has no target -- refuses to render a brief with nothing to review', () => {
  assert.throws(() => renderBrief({ case: { id: 'x', target: null } }), /no target/);
});

test('renderBrief: throws when packet.case is missing entirely', () => {
  assert.throws(() => renderBrief({}), /packet.case is required/);
});

test('renderBrief: includes the target path and the output-contract instructions', () => {
  const brief = renderBrief({ case: { id: 'x', target: '/some/repo', description: 'test case' } });
  assert.match(brief, /\/some\/repo/);
  assert.match(brief, /fenced code block labeled json/);
  assert.match(brief, /"findings"/);
});

test('renderBrief: identical packet produces byte-identical output on repeated calls (arms 1 and 2 must see the same brief)', () => {
  const packet = { case: { id: 'x', target: '/some/repo', description: 'test case', scope: 'src/' } };
  assert.equal(renderBrief(packet), renderBrief(packet));
});

test('renderBrief: omits the Scope line when the case has no scope', () => {
  const brief = renderBrief({ case: { id: 'x', target: '/some/repo' } });
  assert.doesNotMatch(brief, /Scope:/);
});

test('mapClaudeCliResult: extracts result text, usage, and total_cost_usd from a real-shaped claude -p --output-format json payload', () => {
  const payload = JSON.stringify({
    result: 'my review text\n```json\n{"findings":[]}\n```',
    total_cost_usd: 0.23178,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10,
      output_tokens: 50,
      output_tokens_details: { thinking_tokens: 20 },
    },
  });
  const mapped = mapClaudeCliResult(payload);
  assert.equal(mapped.error, undefined);
  assert.match(mapped.text, /my review text/);
  assert.equal(mapped.usage.source, 'provider');
  assert.equal(mapped.usage.estimated_cost_usd, 0.23178);
  assert.equal(mapped.usage.thinking_tokens, 20);
  assert.deepEqual(mapped.usage.raw, JSON.parse(payload));
});

test('mapClaudeCliResult: invalid JSON stdout is reported as an error, never throws', () => {
  const mapped = mapClaudeCliResult('not json at all');
  assert.ok(mapped.error);
});

test('mapClaudeCliResult: missing usage/total_cost_usd fields degrade to null, not a crash', () => {
  const mapped = mapClaudeCliResult(JSON.stringify({ result: 'text' }));
  assert.equal(mapped.usage.estimated_cost_usd, null);
  assert.equal(mapped.usage.input_tokens, null);
});

test('parseFindingsBlock: a response with more than one fenced json block is an error (fail-closed, never guesses which one)', () => {
  const text = '```json\n{"findings":[]}\n```\nsome text\n```json\n{"findings":[{"id":"F1"}]}\n```';
  const result = parseFindingsBlock(text);
  assert.ok(result.error);
  assert.match(result.error, /exactly one/);
});

// runArm's spawn-free paths (union, and a throw-before-spawn refusal) are
// exercised directly here -- no provider CLI involved, so no live gate needed.

test('runArm("union"): merges claude-alone\'s and codex-alone\'s already-written result.json from the same trial', async (t) => {
  const trialDir = await withTmpDir(t);
  await mkdir(path.join(trialDir, 'claude-alone'), { recursive: true });
  await mkdir(path.join(trialDir, 'codex-alone'), { recursive: true });
  await writeFile(
    path.join(trialDir, 'claude-alone', 'result.json'),
    JSON.stringify({ status: 'completed', findings: [{ id: 'F1', location: 'src/x.py:10-20' }] }),
    'utf8'
  );
  await writeFile(
    path.join(trialDir, 'codex-alone', 'result.json'),
    JSON.stringify({ status: 'completed', findings: [{ id: 'F1', location: 'src/x.py:15-25' }] }),
    'utf8'
  );
  const result = await runArm({ arm: 'union', packet: {}, runDir: path.join(trialDir, 'union') });
  assert.equal(result.status, 'completed');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].independently_discovered, true);
});

test('runArm("union"): refuses when claude-alone or codex-alone has not completed in this trial', async (t) => {
  const trialDir = await withTmpDir(t);
  await mkdir(path.join(trialDir, 'claude-alone'), { recursive: true });
  await mkdir(path.join(trialDir, 'codex-alone'), { recursive: true });
  await writeFile(
    path.join(trialDir, 'claude-alone', 'result.json'),
    JSON.stringify({ status: 'failed', findings: null }),
    'utf8'
  );
  await writeFile(
    path.join(trialDir, 'codex-alone', 'result.json'),
    JSON.stringify({ status: 'completed', findings: [] }),
    'utf8'
  );
  const result = await runArm({ arm: 'union', packet: {}, runDir: path.join(trialDir, 'union') });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /to have completed in this trial/);
});

test('runArm("union"): refuses (throws) when claude-alone/codex-alone have not run at all in this trial', async (t) => {
  const trialDir = await withTmpDir(t);
  await assert.rejects(
    () => runArm({ arm: 'union', packet: {}, runDir: path.join(trialDir, 'union') }),
    /must run before union/
  );
});

test('runArm("claude-alone"): a case with no target throws before any spawn is attempted', async (t) => {
  const runDir = await withTmpDir(t);
  await assert.rejects(
    () => runArm({ arm: 'claude-alone', packet: { case: { id: 'x', target: null } }, runDir }),
    /no target/
  );
});

test('runArm("skillarray"): a case with no target throws before any spawn is attempted', async (t) => {
  const runDir = await withTmpDir(t);
  await assert.rejects(
    () => runArm({ arm: 'skillarray', packet: { case: { id: 'x', target: null } }, runDir }),
    /no target/
  );
});

test('runArm: an unknown arm name throws', async (t) => {
  const runDir = await withTmpDir(t);
  await assert.rejects(() => runArm({ arm: 'not-a-real-arm', packet: {}, runDir }), /unknown arm/);
});
