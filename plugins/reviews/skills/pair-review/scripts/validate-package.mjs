#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = path.basename(root);
// Normalize CRLF so a Windows checkout with core.autocrlf=true still validates.
const entry = (await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
if (!entry.startsWith('---\n') || !entry.includes('\nname: ' + skill + '\n')) {
  throw new Error('SKILL.md frontmatter identity does not match its directory');
}
if (!/\ndescription:\s*>-?\n/.test(entry)) throw new Error('Missing description');
await fs.access(path.join(root, 'LICENSE'));
async function check(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { await check(file); continue; }
    if (item.name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file]);
    if (!item.name.endsWith('.md')) continue;
    const body = await fs.readFile(file, 'utf8');
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|#)/.test(target)) continue;
      await fs.access(path.resolve(path.dirname(file), target.split('#')[0]));
    }
  }
}
await check(root);
process.stdout.write(skill + ': identity, license, local links, and JavaScript syntax passed\n');
