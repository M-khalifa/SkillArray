import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groundTruth, buildCase } from '../case-from-run.mjs';
import { scoreRun } from '../score.mjs';

const SCRIPT = fileURLToPath(new URL('../case-from-run.mjs', import.meta.url));
const REPO = path.resolve(path.dirname(SCRIPT), '..');

const FINDINGS = {
  findings: [
    { id: 'F1', severity: 'HIGH', final_state: 'settled-agree', summary: 'Last slot is never read.', evidence: ['src/pg.py:40 loops to n-1', 'tests/test_pg.py:9'] },
    { id: 'F2', severity: 'MEDIUM', final_state: 'settled-refuted', summary: 'Refuted claim.', evidence: ['src/a.py:1'] },
    { id: 'F3', severity: 'LOW', severity_audited: 'MEDIUM', final_state: 'unresolved-low-stakes', summary: 'Disputed, then fixed.', evidence: ['src/b.py:7'] },
    { id: 'F4', severity: 'HIGH', final_state: 'settled-agree', summary: 'Agreed, then marked wrong.', evidence: ['src/c.py:3'] },
  ],
};
const NOTES = '## Finding status\n- F3: fixed\n- F4: wrong: the input never happens\n';

test('groundTruth: settled-agree findings only; with outcomes, "fixed" adds one and "wrong" removes one; hints are file:line by base name', () => {
  const plain = groundTruth(FINDINGS, NOTES, false);
  assert.deepEqual(plain.defects.map((d) => d.source_finding), ['F1', 'F4'], 'a refuted finding is never ground truth');
  assert.deepEqual(plain.defects[0], { id: 'D1', description: 'Last slot is never read.', severity: 'HIGH', matches: ['pg.py:40', 'test_pg.py:9'], source_finding: 'F1', confirmed_by: null });
  const withOutcomes = groundTruth(FINDINGS, NOTES, true);
  assert.deepEqual(withOutcomes.defects.map((d) => [d.source_finding, d.severity]), [['F1', 'HIGH'], ['F3', 'MEDIUM']]);
});

test('buildCase: writes case.json, ground-truth.json and the packet; score.mjs reads the ground truth; inside this repository it is refused without --public', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'case-from-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\n## Scope\nsrc/pg.py paging.\n\n## Output\nx\n');
  const out = path.join(root, 'cases', 'pg-last-slot');
  const r = await buildCase({ runDir: run, target: path.join(root, 'snapshot'), out, outcomes: false, public: false });
  assert.equal(r.defects, 2);
  const caseJson = JSON.parse(await fs.readFile(path.join(out, 'case.json'), 'utf8'));
  assert.equal(caseJson.id, 'pg-last-slot');
  assert.equal(caseJson.scope, 'src/pg.py paging.');
  assert.equal(caseJson.target, path.join(root, 'snapshot'));
  assert.ok(await fs.readFile(path.join(out, 'task-packet.md'), 'utf8'));
  const truth = JSON.parse(await fs.readFile(path.join(out, 'ground-truth.json'), 'utf8'));
  const scored = scoreRun({ findings: [{ id: 'F9', severity: 'HIGH', final_state: 'settled-agree', evidence: ['targets/src/pg.py:40 off by one'] }], defects: truth.defects });
  assert.equal(scored.counts.true_positives, 1, 'a finding at the same file:line under another folder matches D1');
  assert.equal(scored.defect_to_finding.D1, 'F9');
  await assert.rejects(buildCase({ runDir: run, target: root, out, outcomes: false, public: false }), /already exists/);
  // Round 7 F10: a folder holding only an earlier packet (or ground truth) is refused before anything is written.
  for (const name of ['task-packet.md', 'ground-truth.json']) {
    const partial = path.join(root, `partial-${name}`);
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, name), 'keep me\n');
    await assert.rejects(buildCase({ runDir: run, target: root, out: partial, outcomes: false, public: false }), new RegExp(`${name.replace('.', '\\.')} already exists.*nothing was written`));
    assert.deepEqual((await fs.readdir(partial)).sort(), [name]);
    assert.equal(await fs.readFile(path.join(partial, name), 'utf8'), 'keep me\n');
  }
  const forbidden = path.join(REPO, 'bench', 'cases', 'zz-should-not-exist');
  assert.equal(await fs.access(forbidden).then(() => true, () => false), false, 'left over from an earlier run');
  // A regression that writes it anyway must not leave it in the repository.
  t.after(() => fs.rm(forbidden, { recursive: true, force: true }));
  const cli = spawnSync(process.execPath, [SCRIPT, '--run-dir', run, '--target', root, '--out', forbidden], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /inside the SkillArray repository/);
  assert.equal(await fs.access(forbidden).then(() => true, () => false), false);
});
