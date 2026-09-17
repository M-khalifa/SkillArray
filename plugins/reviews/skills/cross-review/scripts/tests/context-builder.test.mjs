// Tests for ../context-builder.mjs. Spawns real `git` child processes
// against disposable temp git repos -- no network, no provider CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs, buildPacket, computeProxyMetric, extractPathTokens, extractChangedSymbols,
  candidateTestPaths, RelayError,
} from '../context-builder.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

async function makeGitRepoWithDiff(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'context-builder-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'a@b.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  await writeFile(path.join(dir, 'lib.py'), 'def helper():\n    return 1\n', 'utf8');
  await writeFile(path.join(dir, 'unrelated.py'), 'x = 1\n', 'utf8');
  git(['add', 'lib.py', 'unrelated.py'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  const base = git(['rev-parse', 'HEAD'], dir).trim();

  await writeFile(
    path.join(dir, 'lib.py'),
    'def helper():\n    return 2\n\ndef new_function():\n    return 3\n',
    'utf8'
  );
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'tests', 'test_lib.py'), 'def test_helper():\n    pass\n', 'utf8');
  git(['add', 'lib.py', 'tests/test_lib.py'], dir);
  git(['commit', '-q', '-m', 'second'], dir);

  return { dir, base };
}

async function makeGitRepoWithSubdirDiff(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'context-builder-subdir-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'a@b.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await writeFile(path.join(dir, 'sub', 'lib.py'), 'def helper():\n    return 1\n', 'utf8');
  git(['add', 'sub/lib.py'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  const base = git(['rev-parse', 'HEAD'], dir).trim();

  await writeFile(path.join(dir, 'sub', 'lib.py'), 'def helper():\n    return 2\n', 'utf8');
  await mkdir(path.join(dir, 'sub', 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'sub', 'tests', 'test_lib.py'), 'def test_helper():\n    pass\n', 'utf8');
  git(['add', 'sub/lib.py', 'sub/tests/test_lib.py'], dir);
  git(['commit', '-q', '-m', 'second'], dir);

  return { dir, subdir: path.join(dir, 'sub'), base };
}

test('parseArgs: build mode requires --cd', () => {
  assert.throws(() => parseArgs(['--base', 'HEAD']), /--cd/);
});

test('parseArgs: --proxy-metric requires --findings and --packet', () => {
  assert.throws(() => parseArgs(['--proxy-metric']), /--findings.*--packet/);
  assert.throws(() => parseArgs(['--proxy-metric', '--findings', 'x.json']), /--findings.*--packet/);
});

test('buildPacket: a non-git directory falls back to packet:null with a reason, never a guess', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'context-builder-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await buildPacket({ cd: dir, base: 'HEAD', symbolFileCap: 10 });
  assert.equal(result.packet, null);
  assert.match(result.reason, /not a git repository/);
});

test('buildPacket: no --base given falls back to packet:null, never guesses a diff base', async (t) => {
  const { dir } = await makeGitRepoWithDiff(t);
  const result = await buildPacket({ cd: dir, base: null, symbolFileCap: 10 });
  assert.equal(result.packet, null);
  assert.match(result.reason, /no --base given/);
});

test('buildPacket: an invalid --base ref falls back to packet:null with a reason', async (t) => {
  const { dir } = await makeGitRepoWithDiff(t);
  const result = await buildPacket({ cd: dir, base: 'not-a-real-ref', symbolFileCap: 10 });
  assert.equal(result.packet, null);
  assert.match(result.reason, /does not resolve/);
});

test('buildPacket: a real diff produces changedFiles (only the diffed files, not unrelated ones) and the raw diff text', async (t) => {
  const { dir, base } = await makeGitRepoWithDiff(t);
  const result = await buildPacket({ cd: dir, base, symbolFileCap: 10 });
  assert.notEqual(result.packet, null);
  assert.deepEqual(new Set(result.packet.changedFiles), new Set(['lib.py', 'tests/test_lib.py']));
  assert.equal(result.packet.changedFiles.includes('unrelated.py'), false);
  assert.match(result.packet.diff, /new_function/);
});

test('buildPacket: changedFiles and colocatedTests use forward-slash paths on every platform (matches git\'s own output)', async (t) => {
  const { dir, base } = await makeGitRepoWithDiff(t);
  const result = await buildPacket({ cd: dir, base, symbolFileCap: 10 });
  for (const f of result.packet.changedFiles) {
    assert.equal(f.includes('\\'), false, `changedFiles entry "${f}" must not contain a backslash`);
  }
  for (const tests of Object.values(result.packet.colocatedTests)) {
    for (const t2 of tests) {
      assert.equal(t2.includes('\\'), false, `colocatedTests entry "${t2}" must not contain a backslash`);
    }
  }
});

test('buildPacket: colocated test found by naming convention (foo.py -> tests/test_foo.py)', async (t) => {
  const { dir, base } = await makeGitRepoWithDiff(t);
  const result = await buildPacket({ cd: dir, base, symbolFileCap: 10 });
  assert.deepEqual(result.packet.colocatedTests['lib.py'], ['tests/test_lib.py']);
});

test('buildPacket: symbol grep finds a file referencing a newly-defined symbol', async (t) => {
  const { dir, base } = await makeGitRepoWithDiff(t);
  const result = await buildPacket({ cd: dir, base, symbolFileCap: 10 });
  assert.ok(result.packet.symbolReferences.new_function.includes('lib.py'));
});

test('candidateTestPaths: an unrecognized extension returns no candidates rather than guessing', async () => {
  const paths = await candidateTestPaths('/nonexistent', 'file.rs');
  assert.deepEqual(paths, []);
});

test('extractChangedSymbols: extracts python def/class and JS export const/function/class from diff +/- lines', () => {
  const diff = [
    '+def new_func():',
    '-def old_func():',
    '+class NewClass:',
    '+export const myConst = 1;',
    '+export function myFunc() {}',
    ' unchanged_line_not_a_diff_marker',
  ].join('\n');
  const symbols = extractChangedSymbols(diff);
  assert.deepEqual(new Set(symbols), new Set(['new_func', 'old_func', 'NewClass', 'myConst', 'myFunc']));
});

test('extractPathTokens: extracts a nested path, ignores a bare basename and plain prose words', () => {
  const tokens = extractPathTokens('See src/lib/a.py:10 and also b.txt for context, not just prose here');
  assert.ok(tokens.includes('src/lib/a.py'));
  // Bare basenames (no path separator) are deliberately never extracted here
  // -- see PATH_TOKEN_RE's comment in context-builder.mjs: on real prose a
  // bare token like "b.txt" is indistinguishable from a number or
  // abbreviation, so this metric only ever flags tokens that look like an
  // actual path.
  assert.equal(tokens.includes('b.txt'), false);
  assert.equal(tokens.includes('prose'), false);
});

test('computeProxyMetric: a citation matching a packet file (full path) is NOT flagged as outside the packet', () => {
  const packet = { changedFiles: ['src/a.py'] };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['src/a.py:10 has an issue'] }] };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(result.citedOutsidePacket, []);
  assert.equal(result.totalEvidenceStrings, 1);
});

test('computeProxyMetric: a citation NOT matching any packet file (full path or basename) IS flagged', () => {
  const packet = { changedFiles: ['src/a.py'] };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['unrelated/other.py:5 has an issue'] }] };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.equal(result.citedOutsidePacket.length, 1);
  assert.equal(result.citedOutsidePacket[0].path, 'unrelated/other.py');
});

test('computeProxyMetric: normalizes backslash paths before comparing against the packet', () => {
  const packet = { changedFiles: ['src/a.py'] };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['src\\a.py:10 has an issue'] }] };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(result.citedOutsidePacket, []);
});

test('computeProxyMetric: evidence with no path-like token produces no flagged citations', () => {
  const packet = { changedFiles: ['src/a.py'] };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['this is prose with no file reference at all'] }] };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(result.citedOutsidePacket, []);
  assert.equal(result.totalEvidenceStrings, 1);
});

test('computeProxyMetric: this is a mechanical rule, deterministic on repeated calls with the same input', () => {
  const packet = { changedFiles: ['src/a.py'] };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['src/a.py and unrelated/b.py both mentioned'] }] };
  const first = computeProxyMetric(findingsDoc, packet);
  const second = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(first, second);
});

test('computeProxyMetric: bare numbers/abbreviations/version strings are never flagged (ordinary prose, not a citation)', () => {
  const packet = { changedFiles: ['src/a.py'] };
  const findingsDoc = {
    findings: [{ id: 'F1', evidence: ['the value 3.14, see e.g. section 1.5, upgraded to v2.0 of the lib'] }],
  };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(result.citedOutsidePacket, []);
});

test('computeProxyMetric: a citation of a colocated test file (not in changedFiles) is NOT flagged as outside the packet', () => {
  const packet = {
    changedFiles: ['src/a.py'],
    colocatedTests: { 'src/a.py': ['tests/test_a.py'] },
  };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['tests/test_a.py:3 also affected'] }] };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(result.citedOutsidePacket, []);
});

test('computeProxyMetric: a citation of a symbol-reference file (not in changedFiles) is NOT flagged as outside the packet', () => {
  const packet = {
    changedFiles: ['src/a.py'],
    symbolReferences: { foo: ['src/callers.py'] },
  };
  const findingsDoc = { findings: [{ id: 'F1', evidence: ['src/callers.py:12 calls foo incorrectly'] }] };
  const result = computeProxyMetric(findingsDoc, packet);
  assert.deepEqual(result.citedOutsidePacket, []);
});

test('buildPacket: a new UNTRACKED file (created since --base, never git-added) appears in changedFiles', async (t) => {
  const { dir, base } = await makeGitRepoWithDiff(t);
  await writeFile(path.join(dir, 'brand-new.py'), 'x = 1\n', 'utf8');
  const result = await buildPacket({ cd: dir, base, symbolFileCap: 10 });
  assert.ok(result.packet.changedFiles.includes('brand-new.py'), 'a new untracked file must appear in changedFiles');
});

test('buildPacket: --cd as a SUBDIRECTORY produces cd-relative changedFiles/colocatedTests, not repo-root-relative paths', async (t) => {
  const { subdir, base } = await makeGitRepoWithSubdirDiff(t);
  const result = await buildPacket({ cd: subdir, base, symbolFileCap: 10 });
  assert.notEqual(result.packet, null, result.reason);
  assert.deepEqual(new Set(result.packet.changedFiles), new Set(['lib.py', 'tests/test_lib.py']));
  assert.deepEqual(result.packet.colocatedTests['lib.py'], ['tests/test_lib.py']);
});
