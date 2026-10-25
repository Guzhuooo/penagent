import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'test/' + name);
for (const args of [['test/runner.mjs'], ['--test', ...files]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error('Test process could not start'); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
