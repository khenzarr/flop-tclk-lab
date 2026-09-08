import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealObserve, WRITE1_OPERATION } from './phase3b-submit-observe.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, operationId, extra] = process.argv.slice(2);
  if (flag !== '--operation' || operationId !== WRITE1_OPERATION || extra !== undefined) {
    console.error('USAGE: phase3b:observe -- --operation phase3b-write-1');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(await runRealObserve({ operationId }))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}