// Fixture-only command surface. It intentionally has no custody or network imports.
const [command, flag, selected] = process.argv.slice(2);
if (!['sign', 'submit', 'observe'].includes(command) || flag !== '--operation' || !/^phase3b-write-[1-6]$/.test(selected ?? '')) {
  console.error('USAGE: phase3b2-cli.mjs <sign|submit|observe> --operation <frozen-operation-id>'); process.exitCode = 2;
} else if (command === 'sign') {
  console.error('FIXTURE_ONLY: real signing is disabled; no custody, nonce, or network is reachable.'); process.exitCode = 3;
} else if (command === 'submit' || command === 'observe') {
  console.error('FIXTURE_ONLY: real submission and observation are disabled; no network is reachable.'); process.exitCode = 3;
}