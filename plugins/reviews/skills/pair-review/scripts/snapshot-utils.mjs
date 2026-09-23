// Content-hash inventory of a plain directory, for targets that are not git repositories.
// Gives preflight a snapshotHash and the dispatchers a touchedFiles list when git status cannot.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
export const DEFAULT_MAX_FILES = 20000;

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Returns { files: { 'rel/path': sha256 }, snapshotHash }. Paths use '/' on every platform.
// Throws when the tree holds more than maxFiles files, rather than hashing a partial tree.
export async function hashInventory(dir, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  const rels = [];
  async function walk(abs, rel) {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        rels.push(rel ? `${rel}/${entry.name}` : entry.name);
        if (rels.length > maxFiles) {
          throw new Error(`"${dir}" holds more than ${maxFiles} files; refusing a partial inventory`);
        }
      }
    }
  }
  await walk(dir, '');
  rels.sort();
  const files = {};
  const combined = createHash('sha256');
  combined.update('inventory-v1\n');
  for (const rel of rels) {
    files[rel] = await sha256OfFile(path.join(dir, ...rel.split('/')));
    combined.update(`${rel}:${files[rel]}\n`);
  }
  return { files, snapshotHash: combined.digest('hex') };
}

// Paths added, removed, or changed between two hashInventory().files maps, sorted.
export function diffInventories(before, after) {
  const changed = new Set();
  for (const [rel, hash] of Object.entries(after)) {
    if (before[rel] !== hash) changed.add(rel);
  }
  for (const rel of Object.keys(before)) {
    if (!Object.hasOwn(after, rel)) changed.add(rel);
  }
  return [...changed].sort();
}
