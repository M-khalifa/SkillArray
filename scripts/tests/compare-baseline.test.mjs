import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../compare-baseline.mjs', import.meta.url));
const SKILLS = ['cross-review', 'pair-review'];
const SENTENCE_ONE = 'The first rule sentence is long enough to be checked.';
const SENTENCE_TWO = 'The second rule sentence is long enough to be checked.';
const MOVED = 'The moved rule sentence lives in the protocol file now.';

const STUB = [
  "import fs from 'node:fs';",
  'const a = process.argv.slice(2);',
  "const get = (f) => { const i = a.indexOf(f); return i < 0 ? '-' : a[i + 1]; };",
  "fs.writeFileSync(get('--out'), 'mode=' + get('--mode') + ' seat=' + get('--seat') + ' marker=MARK packet=' + get('--packet') + '\\n');",
  '',
].join('\n');

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function skillDir(root, skill) {
  return path.join(root, 'plugins', skill, 'skills', skill);
}

function put(root, skill, rel, text) {
  const file = path.join(skillDir(root, skill), rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function skillMd(...sentences) {
  return `---\nname: x\n---\n\n# Title\n\n${sentences.join(' ')}\n`;
}

function makeRepo(t) {
  const root = tempDir(t, 'cmp-base-repo-');
  git(root, 'init', '-q');
  for (const skill of SKILLS) {
    put(root, skill, 'SKILL.md', skillMd(SENTENCE_ONE, SENTENCE_TWO));
    put(root, skill, 'references/protocol.md', '# Protocol\n\nA protocol sentence that is long enough to count.\n');
    put(root, skill, 'scripts/build-brief.mjs', STUB.replace('MARK', 'one'));
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function runTool(root, extra = [], env = {}) {
  return spawnSync(process.execPath, [tool, '--base', 'HEAD', '--root', root, '--drops', path.join(root, 'drops.txt'), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeDrops(root, lines) {
  writeFileSync(path.join(root, 'drops.txt'), `${lines.join('\n')}\n`);
}

test('identical trees pass and the summary counts briefs, items and drops', (t) => {
  const root = makeRepo(t);
  const r = runTool(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /passed against HEAD: 14 briefs identical, \d+ rule items checked, 0 drops used/);
});

test('a missing drops file is read as empty and --init-drops is the only way the tool writes one', (t) => {
  const root = makeRepo(t);
  assert.equal(runTool(root).status, 0);
  assert.equal(existsSync(path.join(root, 'drops.txt')), false);
  assert.equal(runTool(root, ['--init-drops']).status, 0);
  assert.match(readFileSync(path.join(root, 'drops.txt'), 'utf8'), /^# .*<TAB><reason>\n$/);
});

test('one changed brief byte fails and names the brief, the skill and the first differing line', (t) => {
  const root = makeRepo(t);
  put(root, 'pair-review', 'scripts/build-brief.mjs', STUB.replace('MARK', 'two'));
  const r = runTool(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /brief phase1-seat-A \[pair-review\] differs at line 1/);
  assert.match(r.stderr, /marker=one/);
  assert.match(r.stderr, /marker=two/);
  assert.doesNotMatch(r.stderr, /\[cross-review\] differs/);
});

test('a deleted sentence fails and is printed with its skill and base file', (t) => {
  const root = makeRepo(t);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  const r = runTool(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`\\[cross-review\\] SKILL\\.md: ${SENTENCE_TWO.replace(/\./g, '\\.')}`));
  assert.match(r.stderr, /1 base rule item\(s\) missing/);
});

test('the same sentence moved to another file of the same skill passes', (t) => {
  const root = makeRepo(t);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  put(root, 'cross-review', 'references/protocol.md', `# Protocol\n\nA protocol sentence that is long enough to count.\n\n${SENTENCE_TWO}\n`);
  const r = runTool(root);
  assert.equal(r.status, 0, r.stderr);
});

test('a sentence moved to the other skill does not count', (t) => {
  const root = makeRepo(t);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  put(root, 'pair-review', 'references/protocol.md', `# Protocol\n\nA protocol sentence that is long enough to count.\n\n${SENTENCE_TWO}\n`);
  assert.equal(runTool(root).status, 1);
});

test('rewrapped lines, emphasis and backticks do not change a sentence', (t) => {
  const root = makeRepo(t);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE, SENTENCE_TWO).replace('first rule', '**first**\nrule').replace('long enough', '`long`\n  enough'));
  const r = runTool(root);
  assert.equal(r.status, 0, r.stderr);
});

test('every non-empty line inside a code fence is its own item', (t) => {
  const root = makeRepo(t);
  const fenced = '# Doc\n\n```text\n## a fenced line that is long enough to count\nanother fenced line that is long enough\n```\n';
  put(root, 'cross-review', 'references/fenced.md', fenced);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fenced');
  put(root, 'cross-review', 'references/fenced.md', fenced.replace('another fenced line that is long enough\n', ''));
  const r = runTool(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[cross-review\] references\/fenced\.md: another fenced line that is long enough/);
  assert.doesNotMatch(r.stderr, /## a fenced line/);
});

test('a deleted sentence listed in the drops file with a reason passes and counts as a used drop', (t) => {
  const root = makeRepo(t);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  put(root, 'pair-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  writeDrops(root, ['# comment', '', `${SENTENCE_TWO}\tremoved on purpose`]);
  const r = runTool(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 drops used/);
});

test('a drop without a reason fails', (t) => {
  const root = makeRepo(t);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  put(root, 'pair-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  writeDrops(root, [SENTENCE_TWO, `${SENTENCE_TWO}\t  `]);
  const r = runTool(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /drops line 1: drop has no reason/);
  assert.match(r.stderr, /drops line 2: drop has no reason/);
});

test('a drop that matches no base item is a stale drop and fails', (t) => {
  const root = makeRepo(t);
  writeDrops(root, [`${MOVED}\tnever existed`]);
  const r = runTool(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /drops line 1: stale drop/);
});

test('an unknown revision fails with a clear message before anything is extracted', (t) => {
  const root = makeRepo(t);
  const r = spawnSync(process.execPath, [tool, '--base', 'no-such-rev', '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /revision "no-such-rev" does not resolve to a commit/);
});

test('the temp folder is removed after a success and after a failure', (t) => {
  const root = makeRepo(t);
  const scratch = tempDir(t, 'cmp-base-scratch-');
  const env = { TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  assert.equal(runTool(root, [], env).status, 0);
  assert.deepEqual(readdirSync(scratch), []);
  put(root, 'cross-review', 'SKILL.md', skillMd(SENTENCE_ONE));
  put(root, 'pair-review', 'scripts/build-brief.mjs', STUB.replace('MARK', 'two'));
  assert.equal(runTool(root, [], env).status, 1);
  assert.deepEqual(readdirSync(scratch), []);
});
