import { writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
}
