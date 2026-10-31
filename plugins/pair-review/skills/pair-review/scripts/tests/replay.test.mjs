// Stored run folders replayed through the pipeline must give the recorded result. The summary (exit codes, status,
// finding states) is checked everywhere; the exact bytes of every output only on Windows, where the record was made.
// REPLAY_UPDATE=1 rewrites the record (say why in the change).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayRun, summaryOf, sha256, NORMALIZED } from './replay-seam.mjs';
import { parseSeatFile } from '../seat-file.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay');
const FIXTURES = fs.readdirSync(ROOT).filter((name) => fs.existsSync(path.join(ROOT, name, 'input'))).sort();
const update = process.env.REPLAY_UPDATE === '1';

function hashesOf({ steps, outputs }) {
  const out = {};
  for (const s of steps) out[`step ${s.name}`] = sha256(`${s.code}\n${s.stdout}\n${s.stderr}`);
  for (const [name, text] of Object.entries(outputs)) out[name] = sha256(text);
  return out;
}

test('the replay normalizes only the listed fields', () => {
  assert.deepEqual(NORMALIZED, ['replay folder path', 'run_id', 'orchestrator usage', 'worktree paths', 'start/end times', 'durations', 'brief byte counts', 'skill name and version line', 'manifest skill_version']);
  assert.ok(FIXTURES.length >= 9, `expected the stored runs under ${ROOT}`);
});

// Each stored seat file the seat-file reader refuses keeps its stated reasons, and its corrected copy is taken and replays.
for (const name of FIXTURES) {
  test(`stored run ${name}: the seat-file reader's reasons for each stored seat file are the recorded ones`, () => {
    const got = {};
    for (const seat of ['A', 'B']) {
      got[seat] = parseSeatFile(fs.readFileSync(path.join(ROOT, name, 'input', 'run', 'phase1', 'original', `${seat}-findings.md`), 'utf8'), seat).problems;
      const fixed = path.join(ROOT, name, 'corrected', `${seat}-findings.md`);
      assert.equal(fs.existsSync(fixed), got[seat].length > 0, `${name}/${seat}: a corrected copy exists exactly when the stored file is refused`);
      if (fs.existsSync(fixed)) assert.deepEqual(parseSeatFile(fs.readFileSync(fixed, 'utf8'), seat).problems, [], `${name}/${seat} corrected copy`);
    }
    const file = path.join(ROOT, name, 'expected', 'refusals.json');
    if (update) fs.writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`);
    else assert.deepEqual(got, JSON.parse(fs.readFileSync(file, 'utf8')));
  });
  if (!fs.existsSync(path.join(ROOT, name, 'corrected'))) continue;
  test(`replay of stored run ${name} with its corrected seat files gives the recorded result`, async () => {
    const summary = summaryOf(await replayRun(path.join(ROOT, name), { corrected: true }));
    const file = path.join(ROOT, name, 'expected', 'summary-corrected.json');
    if (update) fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
    else assert.deepEqual(summary, JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(summary.missing_seat_files, null, 'the corrected seat files are taken');
  });
}

for (const name of FIXTURES) {
  test(`replay of stored run ${name} gives the recorded result`, async () => {
    const result = await replayRun(path.join(ROOT, name));
    const summary = summaryOf(result);
    const hashes = hashesOf(result);
    const expected = path.join(ROOT, name, 'expected');
    if (update) {
      fs.mkdirSync(expected, { recursive: true });
      fs.writeFileSync(path.join(expected, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      if (process.platform === 'win32') fs.writeFileSync(path.join(expected, 'hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`);
      return;
    }
    assert.deepEqual(summary, JSON.parse(fs.readFileSync(path.join(expected, 'summary.json'), 'utf8')));
    if (process.platform !== 'win32') return;
    const want = JSON.parse(fs.readFileSync(path.join(expected, 'hashes.json'), 'utf8'));
    const differ = Object.keys({ ...want, ...hashes }).filter((k) => want[k] !== hashes[k]);
    if (differ.length > 0) {
      const dump = fs.mkdtempSync(path.join(os.tmpdir(), `replay-${name}-`));
      for (const s of result.steps) fs.writeFileSync(path.join(dump, `step ${s.name}.txt`), `${s.code}\n${s.stdout}\n${s.stderr}`);
      for (const [file, text] of Object.entries(result.outputs)) {
        fs.mkdirSync(path.dirname(path.join(dump, file)), { recursive: true });
        fs.writeFileSync(path.join(dump, file), text);
      }
      assert.fail(`${name}: ${differ.join(', ')} differ from the record; the replay's outputs are in ${dump}`);
    }
  });
}
