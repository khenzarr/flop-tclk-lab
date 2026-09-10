import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildWeb } from '../build.mjs';
import { createFlightRecorderModel } from '../public-capsule-adapter.js';

const capsulePath = new URL('../../evidence/public/phase3b-final-public-capsule.json', import.meta.url);

test('public capsule drives the complete safe and accessible flight recorder', async () => {
  const sourceBefore = await readFile(capsulePath);
  const capsule = JSON.parse(sourceBefore.toString('utf8'));
  const model = createFlightRecorderModel(capsule);
  assert.equal(model.steps.length, 6);
  assert.deepEqual(model.steps.map(step => step.code), ['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM']);
  assert.deepEqual(model.steps.map(step => step.status), [
    'Publicly verified', 'Publicly verified', 'Publicly verified',
    'Receipt and public observation verified', 'Publicly verified', 'Receipt and public observation verified',
  ]);
  assert.equal(model.summary.verifiedSteps, 6); assert.equal(model.summary.unresolvedSteps, 0);
  assert.equal(model.trust.operatorModel, 'ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS');
  assert.equal(model.trust.sameHumanOperator, true); assert.equal(model.trust.independentHumanCounterparty, false);
  for (const step of model.steps.filter(item => item.kind === 'rail')) {
    assert.equal(step.evidence.signed, false); assert.equal(step.evidence.worldWritable, true);
    assert.equal(step.evidence.authorshipProof, 'NONE'); assert.equal(step.evidence.valueMoved, false);
    assert.equal(step.evidence.exactValueMatch, true);
  }

  const temp = await mkdtemp(join(tmpdir(), 'blackbox-web-'));
  try {
    const result = await buildWeb({ outDir: temp });
    assert.equal(result.events, 6);
    const [builtCapsule, hub, html, newDeal, liveDeal, records, css, app, hubApp, connectorClient] = await Promise.all([
      readFile(join(temp, 'evidence', 'phase3b-final-public-capsule.json')),
      readFile(join(temp, 'index.html'), 'utf8'),
      readFile(join(temp, 'deal', 'phase3b-final', 'index.html'), 'utf8'),
      readFile(join(temp, 'deal', 'new', 'index.html'), 'utf8'),
      readFile(join(temp, 'deal', 'live', 'index.html'), 'utf8'),
      readFile(join(temp, 'records', 'index.html'), 'utf8'),
      readFile(join(temp, 'assets', 'styles.css'), 'utf8'),
      readFile(join(temp, 'assets', 'app.js'), 'utf8'),
      readFile(join(temp, 'assets', 'hub-app.js'), 'utf8'),
      readFile(join(temp, 'assets', 'connector-client.js'), 'utf8'),
    ]);
    assert.deepEqual(builtCapsule, sourceBefore);
    const publicSurface = `${hub}\n${html}\n${newDeal}\n${liveDeal}\n${records}\n${css}\n${app}\n${hubApp}\n${connectorClient}\n${builtCapsule.toString('utf8')}`;
    assert.doesNotMatch(publicSurface, /(?:C:\\Users|C:\/Users|blackbox[\\/]state[\\/])/i);
    assert.doesNotMatch(publicSurface, /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxprv[A-Za-z0-9]{20,}|AQAAA[A-Za-z0-9+/=]{40,}/i);
    assert.match(html, /PaperRail is not a payment rail|Not a payment rail/);
    assert.match(html, /One human operator|ONE HUMAN OPERATOR/i);
    assert.match(html, /data-open-evidence/); assert.match(html, /id="timeline"/);
    assert.match(app, /ArrowRight/); assert.match(app, /ArrowLeft/); assert.match(app, /aria-current/);
    assert.match(css, /prefers-reduced-motion/); assert.match(css, /@media \(max-width: 720px\)/);
    assert.match(hub, /pnpm connector/); assert.match(hub, /Import pairing file/);
    assert.match(newDeal, /two distinct local cryptographic profiles/i); assert.match(liveDeal, /Signed ≠ submitted ≠ observed ≠ complete/);
    assert.match(records, /Verified public reference/); assert.match(connectorClient, /sessionStorage/);
    assert.doesNotMatch(connectorClient, /localStorage/); assert.match(connectorClient, /PAIRING_ENDPOINT_REFUSED/);
    assert.match(liveDeal, /SIMULATED \/ LOCAL TEST/); assert.match(hubApp, /Waiting for explicit approval in the local terminal/);
    assert.match(liveDeal, /UNSIGNED · WORLD-WRITABLE · NOT A PAYMENT RAIL/);
    assert.match(liveDeal, /6 actions recorded · 6 actions verified · 0 unresolved/);
    assert.match(connectorClient, /CONNECTOR_OFFLINE/); assert.match(connectorClient, /PAIRING_REQUIRED/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  assert.deepEqual(await readFile(capsulePath), sourceBefore);
});
