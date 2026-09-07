// Phase 3B.2-PREP command surface. Only SIGN is wired to the human-gated detached
// custody boundary; SUBMIT and OBSERVE remain deliberately unreachable here.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { invokeRealDetachedBridge } from './airlock/detached-bridge.mjs';
import { REVIEWED_CANONICAL_COMMIT } from './airlock/budget.mjs';

const [command, flag, selected] = process.argv.slice(2);
const operationPattern = /^phase3b-write-[1-6]$/;

function usage() {
  console.error('USAGE: phase3b2-cli.mjs <sign|submit|observe> --operation <frozen-operation-id>');
  process.exitCode = 2;
}

async function frozenOperation(operationId) {
  if (!operationPattern.test(operationId ?? '')) throw new Error('operation selector is invalid');
  const preview = JSON.parse(await readFile(resolve('evidence/phase3b-write1-execution-preview.json'), 'utf8'));
  if (operationId !== preview.operationId) throw new Error('operation is not frozen for real SIGN');
  if (preview.runtime?.signingCommit !== REVIEWED_CANONICAL_COMMIT) throw new Error('frozen canonical signer is invalid');
  return {
    room: preview.room,
    text: JSON.stringify(preview.publicFields),
    requestId: preview.operationId,
    profile: 'default',
    expectedSignerDid: preview.signerDid,
  };
}

if (!['sign', 'submit', 'observe'].includes(command) || flag !== '--operation' || !operationPattern.test(selected ?? '')) {
  usage();
} else if (command === 'submit' || command === 'observe') {
  console.error('REAL_SUBMIT_AND_OBSERVE_DISABLED: no network or transport is reachable.'); process.exitCode = 3;
} else {
  try {
    const request = await frozenOperation(selected);
    const response = await invokeRealDetachedBridge({
      ...request,
      expectedCanonicalCommit: REVIEWED_CANONICAL_COMMIT,
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}