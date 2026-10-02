import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashInventory, diffInventories } from '../snapshot-utils.mjs';

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
