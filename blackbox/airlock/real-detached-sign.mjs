// HUMAN-ONLY OPERATOR ENTRYPOINT — `pnpm airlock:real-detached-sign`.
//
// PHASE 3A.10.3. The Phase 3A.9 post-approval development stop is gone: after a valid human
// approval this route continues into canonical protected custody. Nothing else was weakened.
//
// This file is deliberately a thin shell. All gates live in ./real-route.mjs, which the fixture
// end-to-end test runs unmodified, so the proven control flow is the production control flow.
//
// There is no --yes, --approve, --force, environment variable, approval file, or retry. The only
// accepted option is --preflight-only, which stops before the approval prompt.
import { runDetachedSigningRoute } from './real-route.mjs';

try {
  const options = process.argv.slice(2);
  const preflightOnly = options.length > 0 && options.every(arg => arg === '--preflight-only');
  if (options.length && !preflightOnly) throw new Error('REFUSED: unsupported option; approval cannot be supplied by CLI');
  await runDetachedSigningRoute({ custody: 'real', preflightOnly });
  process.exitCode = 0;
} catch (error) {
  // Sanitized: refusal reasons only. Child output, credentials, and signatures never appear here.
  console.error(error.message);
  process.exitCode = 1;
}
