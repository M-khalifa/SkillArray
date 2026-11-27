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
const frontLines = entry.split('\n').slice(1);
const frontEnd = frontLines.indexOf('---');
const front = frontEnd < 0 ? frontLines : frontLines.slice(0, frontEnd);
const descAt = front.findIndex((line) => line.startsWith('description:'));
const descHead = descAt < 0 ? '' : front[descAt].slice('description:'.length).trim();
const descBody = [];
if (descAt >= 0) {
  for (let i = descAt + 1; i < front.length && (front[i].trim() === '' || /^[ \t]/.test(front[i])); i++) descBody.push(front[i].trim());
}
const isBlock = /^[>|][+-]?$/.test(descHead);
let description = (isBlock ? descBody : [descHead, ...descBody]).filter(Boolean).join(' ');
if (!isBlock) description = description.replace(/^(["'])(.*)\1$/, '$2');
if (!description) throw new Error('Missing description');
if (description.length > 1024) throw new Error(`SKILL.md description is ${description.length} characters; the limit is 1024`);
const lineCount = entry.replace(/\n$/, '').split('\n').length;
if (lineCount > 500) throw new Error(`SKILL.md has ${lineCount} lines; the limit is 500`);
await fs.access(path.join(root, 'LICENSE'));
async function check(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const file = path.join(dir, item.name);
    // Test fixtures hold stored review files verbatim; their links are data, not this package's docs.
    if (item.isDirectory()) { if (!(item.name === 'fixtures' && path.basename(dir) === 'tests')) await check(file); continue; }
    if (item.name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { windowsHide: true });
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
