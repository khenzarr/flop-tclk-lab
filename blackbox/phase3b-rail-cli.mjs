import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionRailPreflight, productionRailWrite } from './phase3b-rail.mjs';

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--operation');
  const operationId = index >= 0 ? args[index + 1] : undefined;
  const preflight = args.includes('--preflight');
  if (index < 0 || !/^phase3b-write-[56]$/.test(operationId ?? '') || args.some((arg, i) => arg === '--operation' ? false : i !== index + 1 && arg !== '--preflight')) {
    console.error('USAGE: phase3b:rail -- --operation phase3b-write-5|phase3b-write-6 [--preflight]');
    process.exitCode = 2;
  } else {
    try {
      const result = preflight ? productionRailPreflight(operationId) : await productionRailWrite(operationId);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}