import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashInventory, hashWriteInventory, diffInventories } from '../snapshot-utils.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'snapshot-utils-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('hashInventory: hashes nested files with forward-slash paths and skips .git/ and node_modules/', async (t) => {
  const dir = await tmp(t);
  await mkdir(path.join(dir, 'images'));
  await mkdir(path.join(dir, '.git'));
  await mkdir(path.join(dir, 'node_modules'));
  await writeFile(path.join(dir, 'article.md'), 'a');
  await writeFile(path.join(dir, 'images', 'fig1.png'), 'b');
  await writeFile(path.join(dir, '.git', 'HEAD'), 'c');
  await writeFile(path.join(dir, 'node_modules', 'x.js'), 'd');
  const inv = await hashInventory(dir);
  assert.deepEqual(Object.keys(inv.files), ['article.md', 'images/fig1.png']);
  assert.match(inv.snapshotHash, /^[0-9a-f]{64}$/);
});

test('hashInventory: the combined hash changes when any file content changes and is stable otherwise', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'a.txt'), 'one');
  const first = await hashInventory(dir);
  assert.equal((await hashInventory(dir)).snapshotHash, first.snapshotHash);
  await writeFile(path.join(dir, 'a.txt'), 'two');
  assert.notEqual((await hashInventory(dir)).snapshotHash, first.snapshotHash);
});

test('hashInventory: a valid tree hashes as "inventory-v1", then "<path>:<sha256>" per file, sorted', async (t) => {
  const dir = await tmp(t);
  await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'b.txt'), 'two');
  await writeFile(path.join(dir, 'sub', 'café.txt'), 'one');
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const expected = sha(`inventory-v1\nb.txt:${sha('two')}\nsub/café.txt:${sha('one')}\n`);
  assert.equal((await hashInventory(dir)).snapshotHash, expected);
});

test('hashInventory: a file or folder name that is not valid UTF-8 (UTF-16 on Windows) is hashed, not an ENOENT', async (t) => {
  const dir = await tmp(t);
  // Linux takes any bytes; Windows stores a lone surrogate, which Node spells as the WTF-8 bytes ED A0 80.
  const bad = process.platform === 'win32' ? [Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xed, 0xa0, 0x81])] : [Buffer.from([0xe9]), Buffer.from([0xea])];
  const at = (...parts) => Buffer.concat([Buffer.from(dir + path.sep), ...parts.flatMap((p, i) => (i ? [Buffer.from(path.sep), p] : [p]))]);
  await writeFile(at(Buffer.concat([Buffer.from('caf'), bad[0], Buffer.from('.txt')])), 'one');
  await writeFile(at(Buffer.concat([Buffer.from('caf'), bad[1], Buffer.from('.txt')])), 'two');
  await mkdir(at(bad[0]));
  await writeFile(at(bad[0], Buffer.from('inner.txt')), 'three');
  const first = await hashInventory(dir);
  const keys = Object.keys(first.files);
  assert.equal(keys.length, 3, keys.join(', '));
  assert.ok(keys.every((k) => /\[bytes [0-9a-f]+\]$/.test(k)), 'each key carries its bytes, so the two names stay apart');
  assert.equal((await hashWriteInventory(dir)).snapshotHash, first.snapshotHash);
  await writeFile(at(bad[0], Buffer.from('inner.txt')), 'changed');
  const second = await hashInventory(dir);
  assert.notEqual(second.snapshotHash, first.snapshotHash);
  assert.equal(diffInventories(first.files, second.files).length, 1);
});

test('hashInventory: refuses a tree larger than maxFiles instead of returning a partial inventory', async (t) => {
  const dir = await tmp(t);
  for (const n of ['a', 'b', 'c']) await writeFile(path.join(dir, n), n);
  await assert.rejects(hashInventory(dir, { maxFiles: 2 }), /more than 2 files/);
});

test('diffInventories: reports added, removed and changed paths, and nothing for an untouched tree', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'keep.txt'), 'k');
  await writeFile(path.join(dir, 'edit.txt'), 'e1');
  await writeFile(path.join(dir, 'gone.txt'), 'g');
  const before = (await hashInventory(dir)).files;
  assert.deepEqual(diffInventories(before, (await hashInventory(dir)).files), []);
  await writeFile(path.join(dir, 'edit.txt'), 'e2');
  await unlink(path.join(dir, 'gone.txt'));
  await writeFile(path.join(dir, 'new.txt'), 'n');
  assert.deepEqual(diffInventories(before, (await hashInventory(dir)).files), ['edit.txt', 'gone.txt', 'new.txt']);
});

test('R2-F15: includeDependencies hashes node_modules, and the default source inventory still skips it', async (t) => {
  const dir = await tmp(t);
  await mkdir(path.join(dir, 'node_modules'));
  await writeFile(path.join(dir, 'app.js'), 'a');
  await writeFile(path.join(dir, 'node_modules', 'dep.js'), 'v1');
  const source = await hashInventory(dir);
  assert.deepEqual(Object.keys(source.files), ['app.js']);
  const all = await hashInventory(dir, { includeDependencies: true });
  assert.deepEqual(Object.keys(all.files), ['app.js', 'node_modules/dep.js']);
  await writeFile(path.join(dir, 'node_modules', 'dep.js'), 'v2');
  assert.equal((await hashInventory(dir)).snapshotHash, source.snapshotHash, 'the source fingerprint ignores a dependency write');
  assert.notEqual((await hashInventory(dir, { includeDependencies: true })).snapshotHash, all.snapshotHash);
});

test('R2-F15: hashWriteInventory covers node_modules and says so; a tree too large with it falls back and reports the gap', async (t) => {
  const dir = await tmp(t);
  await mkdir(path.join(dir, 'node_modules'));
  await writeFile(path.join(dir, 'app.js'), 'a');
  await writeFile(path.join(dir, 'node_modules', 'one.js'), '1');
  await writeFile(path.join(dir, 'node_modules', 'two.js'), '2');
  const covered = await hashWriteInventory(dir);
  assert.equal(covered.dependenciesCovered, true);
  assert.deepEqual(Object.keys(covered.files), ['app.js', 'node_modules/one.js', 'node_modules/two.js']);
  const partial = await hashWriteInventory(dir, { maxFiles: 2 });
  assert.equal(partial.dependenciesCovered, false);
  assert.deepEqual(Object.keys(partial.files), ['app.js']);
  const same = await hashWriteInventory(dir, { includeDependencies: false });
  assert.equal(same.dependenciesCovered, false, 'a caller that already knows the baseline lacked dependencies compares like with like');
  await assert.rejects(hashWriteInventory(dir, { maxFiles: 0 }), /more than 0 files/);
});
