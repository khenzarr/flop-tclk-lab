import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealSubmit } from './phase3b-submit-observe.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, operationId, maybePreflight, extra] = process.argv.slice(2);
  if (flag !== '--operation' || !/^phase3b-write-[1-6]$/.test(operationId ?? '') || (maybePreflight !== undefined && maybePreflight !== '--preflight') || extra !== undefined) {
    console.error('USAGE: phase3b:submit -- --operation phase3b-write-<n> [--preflight]');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(await runRealSubmit({ operationId, preflight: maybePreflight === '--preflight' }))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}