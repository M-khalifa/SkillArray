import { writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const argv = process.argv.slice(2);
const resumed = argv.includes('--resume');
const sessionId = config.sessionId ?? (resumed ? argv[argv.indexOf('--resume') + 1] : 'fixture-session');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
if (config.copyFile) copyFileSync(config.copyFile[0], config.copyFile[1]);
if (config.startedFile) writeFileSync(config.startedFile, 'started');
if (!config.noInit) emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fixture-resolved', tools: [] });
if (config.hang) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(config.pidFile + '.tmp', JSON.stringify([process.pid, grandchild.pid]));
  renameSync(config.pidFile + '.tmp', config.pidFile);
  setInterval(() => {}, 1000);
} else {
  if (config.delayMs) await new Promise(resolve => setTimeout(resolve, config.delayMs));
  if (config.writeCwd) writeFileSync(path.join(process.cwd(), 'tracked.txt'), 'reviewer changed\n');
  if (config.writeTarget) writeFileSync(config.writeTarget, 'absolute target change\n');
  if (config.noise) process.stdout.write('not JSON\n');
  if (config.stderr) process.stderr.write(config.stderr);
  // A tool command run in its own process group that leaves a background job and exits at once (POSIX).
  if (config.toolJob) {
    const shell = spawn('/bin/sh', ['-c', `sleep 300 >/dev/null 2>&1 & echo $! > ${JSON.stringify(config.pidFile)}`], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => shell.on('exit', resolve));
  }
  // The same with a Node job in a session of its own, which macOS shows the environment of (not of /bin/sleep).
  if (config.toolNodeJob) {
    const body = `const j = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(config.pidFile)}, String(j.pid)); j.unref();`;
    const shell = spawn(process.execPath, ['-e', body], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => shell.on('exit', resolve));
  }
  const text = config.text ?? JSON.stringify({ argv, input, cwd: process.cwd(), env: process.env });
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'intermediate' }] } });
  if (!config.noResult) emit({
    type: 'result', subtype: config.isError ? 'error_during_execution' : 'success',
    is_error: config.isError ?? false, session_id: config.resultSessionId ?? sessionId,
    result: text, errors: config.errors ?? [], duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    total_cost_usd: resumed ? 0.02 : 0.01,
    usage: config.noUsage ? undefined : {
      input_tokens: resumed ? 17 : 101, cache_read_input_tokens: resumed ? 23 : 7,
      cache_creation_input_tokens: resumed ? 3 : 11, output_tokens: resumed ? 5 : 13,
    },
    permission_denials: config.denials ?? [],
  });
  process.exitCode = config.exitCode ?? 0;
  // A CLI that answered and exits, leaving a detached process that holds its output open.
  if (config.orphanAfterResult) {
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, cwd: os.tmpdir(), stdio: ['ignore', 'inherit', 'inherit'] });
    writeFileSync(config.pidFile + '.tmp', JSON.stringify([orphan.pid]));
    renameSync(config.pidFile + '.tmp', config.pidFile);
    orphan.unref();
  }
  // A CLI that answered and keeps running, with a process outside its tree (its launcher has exited) holding its output.
  if (config.hangWithOrphan) {
    const body = `const { spawn } = require('node:child_process'); const o = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, cwd: require('node:os').tmpdir(), stdio: ['ignore', 'inherit', 'inherit'] }); require('node:fs').writeFileSync(${JSON.stringify(config.pidFile)}, JSON.stringify([o.pid])); o.unref();`;
    const launcher = spawn(process.execPath, ['-e', body], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
    await new Promise((resolve) => launcher.on('exit', resolve));
    setInterval(() => {}, 1000);
  }
  // A CLI that answered and then never exits (a hook or a child holding it open).
  if (config.hangAfterResult) {
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(config.pidFile + '.tmp', JSON.stringify([process.pid, grandchild.pid]));
    renameSync(config.pidFile + '.tmp', config.pidFile);
    setInterval(() => {}, 1000);
  }
}
