import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionRailObserve } from './phase3b-rail.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const index = args.indexOf('--operation'); const operationId = index >= 0 ? args[index + 1] : undefined;
  if (index < 0 || !/^phase3b-write-[56]$/.test(operationId ?? '') || args.length !== 2) {
    console.error('USAGE: phase3b:rail-observe -- --operation phase3b-write-5|phase3b-write-6'); process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(productionRailObserve(operationId))}\n`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}