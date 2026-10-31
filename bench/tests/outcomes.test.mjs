import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, runRows, tally, renderTable } from '../outcomes.mjs';

const SCRIPT = fileURLToPath(new URL('../outcomes.mjs', import.meta.url));

async function writeRun(root, name, { findings, reviewers, notes }) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), JSON.stringify({ findings }));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ reviewers }));
  if (notes !== undefined) await fs.writeFile(path.join(dir, 'phase3', 'report-notes.md'), notes);
  return dir;
}

test('runRows/tally: a finding counts once per seat model that raised it; the outcome is the notes line\'s first word only', () => {
  const rows = runRows({
    findingsDoc: { findings: [{ id: 'F1', origins: ['A1', 'B2'] }, { id: 'F2', origins: ['A2'] }, { id: 'F3', origins: ['B1'] }] },
    manifest: { reviewers: [{ role: 'A', model_requested: 'opus', model_resolved: 'claude-opus-5-5' }, { role: 'B', model_requested: 'gpt-5.5' }] },
    notesText: '## Finding status\n- F1: fixed\n- F2: wrong: not a defect\n- F3: returns the wrong value\n',
  });
  assert.deepEqual(rows, [
    { id: 'F1', model: 'claude-opus-5-5', outcome: 'fixed' }, { id: 'F1', model: 'gpt-5.5', outcome: 'fixed' },
    { id: 'F2', model: 'claude-opus-5-5', outcome: 'wrong' }, { id: 'F3', model: 'gpt-5.5', outcome: null },
  ]);
  const totals = tally(rows);
  assert.deepEqual(totals.map((t) => [t.model, t.findings, t.fixed, t.wrong, t.none]), [['claude-opus-5-5', 2, 1, 1, 0], ['gpt-5.5', 2, 1, 0, 1]]);
  assert.match(renderTable(totals), /^claude-opus-5-5 +2 +1 +1 +0 +0 +0 +0 +0 +1\/2$/m);
  assert.match(renderTable(tally([{ id: 'F9', model: 'm', outcome: null }])), /n=0$/m, 'no ratio is printed without an outcome');
});

test('CLI: two run folders are added together; a folder without findings.json is an error; --run-dir is required', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-outcomes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reviewers = [{ role: 'A', model_requested: 'opus' }, { role: 'B', model_requested: 'gpt' }];
  const r1 = await writeRun(root, 'r1', { findings: [{ id: 'F1', origins: ['A1'] }], reviewers, notes: '## Finding status\n- F1: wrong: duplicate\n' });
  const r2 = await writeRun(root, 'r2', { findings: [{ id: 'F1', origins: ['A3'] }, { id: 'F2', origins: ['B1'] }], reviewers });
  const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', r1, '--run-dir', r2, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const totals = JSON.parse(r.stdout);
  assert.deepEqual(totals.map((x) => [x.model, x.findings, x.wrong, x.none]), [['gpt', 1, 0, 1], ['opus', 2, 1, 1]]);
  const missing = spawnSync(process.execPath, [SCRIPT, '--run-dir', path.join(root, 'nope')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /has no phase3\/findings\.json/);
  assert.throws(() => parseArgs([]), /give at least one --run-dir/);
});
