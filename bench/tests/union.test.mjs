import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionFindings } from '../adapters/union.mjs';

test('unionFindings: two findings citing the same file with overlapping line ranges are merged, independently_discovered true', () => {
  const a = [{ id: 'A1', location: 'src/retry.py:10-20', severity: 'HIGH' }];
  const b = [{ id: 'B1', location: 'src/retry.py:15-25', severity: 'HIGH' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].independently_discovered, true);
  assert.deepEqual(merged[0].origins, ['A:A1', 'B:B1']);
});

test('unionFindings: two findings on the same file with NON-overlapping line ranges are NOT merged', () => {
  const a = [{ id: 'A1', location: 'src/retry.py:10-20', severity: 'HIGH' }];
  const b = [{ id: 'B1', location: 'src/retry.py:50-60', severity: 'HIGH' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((f) => f.independently_discovered === false));
});

test('unionFindings: two findings on different files are never merged regardless of line ranges', () => {
  const a = [{ id: 'A1', location: 'src/retry.py:10-20' }];
  const b = [{ id: 'B1', location: 'src/other.py:10-20' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 2);
});

test('unionFindings: two findings with no line range on the same path ARE merged (path-only match)', () => {
  const a = [{ id: 'A1', location: 'src/retry.py' }];
  const b = [{ id: 'B1', location: 'src/retry.py' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].independently_discovered, true);
});

test('unionFindings: backslash and forward-slash paths are normalized before comparison', () => {
  const a = [{ id: 'A1', location: 'src\\retry.py:10-20' }];
  const b = [{ id: 'B1', location: 'src/retry.py:15-25' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 1);
});

test('unionFindings: a finding with no location field is never merged with anything, always unique', () => {
  const a = [{ id: 'A1', location: null }];
  const b = [{ id: 'B1', location: null }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((f) => f.independently_discovered === false));
});

test('unionFindings: a single-point line ("path:15") overlapping a range ("path:10-20") is matched', () => {
  const a = [{ id: 'A1', location: 'src/retry.py:15' }];
  const b = [{ id: 'B1', location: 'src/retry.py:10-20' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 1);
});

test('unionFindings: each finding B matches at most one finding A -- a third finding in the same range stays unmatched', () => {
  const a = [
    { id: 'A1', location: 'src/retry.py:10-20' },
    { id: 'A2', location: 'src/retry.py:10-20' },
  ];
  const b = [{ id: 'B1', location: 'src/retry.py:10-20' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 2, 'A1 matches B1; A2 has no B left to match and stays unique');
  const matched = merged.filter((f) => f.independently_discovered);
  assert.equal(matched.length, 1);
});

test('unionFindings: colliding raw IDs across lists (both use "F1") never produce duplicate merged IDs', () => {
  const a = [{ id: 'F1', location: 'src/retry.py:10-20' }];
  const b = [{ id: 'F1', location: 'src/other.py:1-5' }];
  const merged = unionFindings(a, b);
  assert.equal(merged.length, 2, 'different files, never merged');
  const ids = merged.map((f) => f.id);
  assert.equal(new Set(ids).size, 2, 'merged IDs must be unique despite identical raw IDs');
});

test('unionFindings: this is a mechanical rule, no LLM/auditor-style judgment -- deterministic on repeated calls with the same input', () => {
  const a = [{ id: 'A1', location: 'src/retry.py:10-20' }];
  const b = [{ id: 'B1', location: 'src/retry.py:15-25' }];
  const first = unionFindings(a, b);
  const second = unionFindings(a, b);
  assert.deepEqual(first, second);
});
