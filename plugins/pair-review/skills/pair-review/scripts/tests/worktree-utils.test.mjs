import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setupIsolatedWorktree } from '../worktree-utils.mjs';

function git(args, cwd) {
  return execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']});
}

async function repository(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree utils '));
  const target = path.join(dir, 'target');
  await fs.mkdir(path.join(target, 'nested', 'seat'), {recursive:true});
  git(['init','-q'],target);
  git(['config','user.email','test@example.com'],target);
  git(['config','user.name','Test'],target);
  git(['config','core.autocrlf','false'],target);
  await fs.writeFile(path.join(target,'root.txt'),'original\n');
  await fs.writeFile(path.join(target,'nested','seat','tracked.txt'),'seat original\n');
  git(['add','.'],target);
  git(['commit','-q','-m','initial'],target);
  t.after(async () => {
    for (const entry of await fs.readdir(dir)) {
      if (entry === 'target' || entry.endsWith('.snapshot-complete')) continue;
      try { git(['worktree','remove','--force',path.join(dir,entry)],target); } catch {}
    }
    await fs.rm(dir,{recursive:true,force:true});
  });
  return {dir,target,seat:path.join(target,'nested','seat'),worktree:path.join(dir,'worktree')};
}

test('default path directly matches the root snapshot, marker and reuse behavior [slow]', async (t) => {
  const r = await repository(t);
  await fs.writeFile(path.join(r.target,'root.txt'),'dirty\n');
  await fs.writeFile(path.join(r.target,'new.bin'),Buffer.from([0,255,128,10]));
  const first = await setupIsolatedWorktree(r.target,r.worktree);
  assert.deepEqual(first,{ok:true,reused:false,skippedDirs:[]});
  assert.equal(await fs.readFile(path.join(r.worktree,'root.txt'),'utf8'),'dirty\n');
  assert.deepEqual(await fs.readFile(path.join(r.worktree,'new.bin')),Buffer.from([0,255,128,10]));
  const marker = JSON.parse(await fs.readFile(r.worktree+'.snapshot-complete','utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const root = git(['rev-parse','--show-toplevel'],r.target).trim();
  const worktreeRoot = git(['rev-parse','--show-toplevel'],r.worktree).trim();
  const diff = execFileSync('git',['diff','HEAD','--binary'],{cwd:r.target});
  assert.deepEqual(marker,{
    toplevel:process.platform === 'win32' ? root.toLowerCase() : root,
    head:git(['rev-parse','HEAD'],r.target).trim(), diffSha:hash(diff),
    untracked:[{path:'new.bin',sha:hash(Buffer.from([0,255,128,10]))}], skippedDirs:[],
    worktree:{
      toplevel:process.platform === 'win32' ? worktreeRoot.toLowerCase() : worktreeRoot,
      head:marker.head,diffSha:marker.diffSha,untracked:marker.untracked,skippedDirs:[],
    },
  });
  assert.deepEqual(await setupIsolatedWorktree(r.target,r.worktree,{allowSubdir:false}),{ok:true,reused:true,skippedDirs:[]});
  await fs.writeFile(path.join(r.worktree,'root.txt'),'contaminated\n');
  const refused = await setupIsolatedWorktree(r.target,r.worktree);
  assert.equal(refused.ok,false);
  assert.match(refused.reason,/worktree snapshot mismatch/);
  assert.equal(await fs.readFile(path.join(r.worktree,'root.txt'),'utf8'),'contaminated\n');
});

test('repository subdirectory remains refused by default without creating a worktree [slow]', async (t) => {
  const r = await repository(t);
  const result = await setupIsolatedWorktree(r.seat,r.worktree);
  assert.equal(result.ok,false);
  assert.match(result.reason,/not the repository root/);
  await assert.rejects(fs.access(r.worktree),{code:'ENOENT'});
  await assert.rejects(fs.access(r.worktree+'.snapshot-complete'),{code:'ENOENT'});
});

test('allowSubdir snapshots the root and returns relative seat cwd on build and reuse [slow]', async (t) => {
  const r = await repository(t);
  await fs.writeFile(path.join(r.target,'root.txt'),'root dirty\n');
  await fs.writeFile(path.join(r.target,'root-new.txt'),'root untracked\n');
  await fs.writeFile(path.join(r.seat,'tracked.txt'),'seat dirty\n');
  await fs.writeFile(path.join(r.seat,'seat-new.txt'),'seat untracked\n');
  const first = await setupIsolatedWorktree(r.seat,r.worktree,{allowSubdir:true});
  assert.deepEqual(first,{ok:true,reused:false,skippedDirs:[],cwd:path.join(r.worktree,'nested','seat')});
  for (const relative of ['root.txt','root-new.txt','nested/seat/tracked.txt','nested/seat/seat-new.txt']) {
    assert.deepEqual(await fs.readFile(path.join(r.worktree,relative)),await fs.readFile(path.join(r.target,relative)));
  }
  const second = await setupIsolatedWorktree(r.seat,r.worktree,{allowSubdir:true});
  assert.deepEqual(second,{...first,reused:true});
  await fs.writeFile(path.join(r.target,'root.txt'),'outside seat drift\n');
  const drift = await setupIsolatedWorktree(r.seat,r.worktree,{allowSubdir:true});
  assert.equal(drift.ok,false);
  assert.match(drift.reason,/snapshot fingerprint mismatch/);
  assert.equal(await fs.readFile(path.join(r.worktree,'root.txt'),'utf8'),'root dirty\n');
});

test('allowSubdir also returns the worktree cwd for a root seat and rebuilds after cleanup [slow]', async (t) => {
  const r = await repository(t);
  const first = await setupIsolatedWorktree(r.target,r.worktree,{allowSubdir:true});
  assert.deepEqual(first,{ok:true,reused:false,skippedDirs:[],cwd:r.worktree});
  git(['worktree','remove','--force',r.worktree],r.target);
  await fs.access(r.worktree+'.snapshot-complete');
  assert.deepEqual(await setupIsolatedWorktree(r.target,r.worktree,{allowSubdir:true}),first);
});

test('submodules refuse both isolation modes and name --no-isolate without silent fallback [slow]', async (t) => {
  const r = await repository(t);
  const hash = git(['rev-parse','HEAD'],r.target).trim();
  await fs.writeFile(path.join(r.target,'.gitmodules'),'[submodule "child"]\n\tpath = child\n\turl = ./child\n');
  git(['add','.gitmodules'],r.target);
  git(['update-index','--add','--cacheinfo','160000,'+hash+',child'],r.target);
  git(['commit','-q','-m','gitlink fixture'],r.target);
  for (const [target, options] of [[r.target,{}],[r.seat,{allowSubdir:true}]]) {
    const result = await setupIsolatedWorktree(target,r.worktree,options);
    assert.equal(result.ok,false);
    assert.match(result.reason,/submodules/);
    assert.match(result.reason,/--no-isolate/);
    await assert.rejects(fs.access(r.worktree),{code:'ENOENT'});
    await assert.rejects(fs.access(r.worktree+'.snapshot-complete'),{code:'ENOENT'});
  }
});

test('allowSubdir creates an empty seat directory that git does not record [slow]', async (t) => {
  const r = await repository(t);
  const empty = path.join(r.seat,'empty seat');
  await fs.mkdir(empty);
  const result = await setupIsolatedWorktree(empty,r.worktree,{allowSubdir:true});
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.cwd,path.join(r.worktree,'nested','seat','empty seat'));
  assert.equal((await fs.stat(result.cwd)).isDirectory(),true);
  assert.equal((await setupIsolatedWorktree(empty,r.worktree,{allowSubdir:true})).reused,true);
});

test('a --cd typed in another letter case than the folder on disk still resolves to the same subfolder of the snapshot (case-insensitive file systems only) [slow]', async (t) => {
  const r = await repository(t);
  const typed = r.seat.replace(/target/g, 'TARGET');
  const insensitive = await fs.access(typed).then(() => true, () => false);
  if (!insensitive) {
    t.skip('this file system is case-sensitive');
    return;
  }
  const result = await setupIsolatedWorktree(typed, r.worktree, { allowSubdir: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.cwd, path.join(r.worktree, 'nested', 'seat'));
  assert.deepEqual((await fs.readdir(path.dirname(r.worktree))).filter((n) => n.toLowerCase() === 'target' && n !== 'target'), []);
});
