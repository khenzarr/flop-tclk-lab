// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER, signPreflight, runRealSign, submitPreflight, runRealSubmit, runRealObserve,
  railPreflight, railWrite, railObserve, finalize } from './phase3b-s2.mjs';

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [command, flag, id, extra] = process.argv.slice(2);
  const needsId = command !== 'finalize';
  if (!['sign', 'submit', 'observe', 'rail-preflight', 'rail-write', 'rail-observe', 'finalize'].includes(command)
    || (needsId && (flag !== '--operation' || !ORDER.includes(id) || (command === 'sign' ? extra !== undefined && extra !== '--preflight' : extra !== undefined)))
    || (!needsId && flag !== undefined)) {
    console.error('USAGE: phase3b-s2-cli.mjs <sign|submit|observe|rail-preflight|rail-write|rail-observe|finalize> [--operation phase3b-s2-write-N]');
    process.exitCode = 2;
  } else {
    try {
      let result;
      if (command === 'sign') result = extra === '--preflight' ? await signPreflight(id) : await runRealSign(id);
      else if (command === 'submit') result = await runRealSubmit(id);
      else if (command === 'observe') result = await runRealObserve(id);
      else if (command === 'rail-preflight') result = await railPreflight(id);
      else if (command === 'rail-write') result = await railWrite(id);
      else if (command === 'rail-observe') result = await railObserve(id);
      else result = finalize();
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
