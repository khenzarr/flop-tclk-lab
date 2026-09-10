/**
 * @typedef {Object} FlightStep
 * @property {string} operationId
 * @property {'OFFER'|'ACCEPT'|'LOCK'|'RAIL_LOCK'|'REVEAL'|'RAIL_CLAIM'} code
 * @property {string} label
 * @property {string} actor
 * @property {string} action
 * @property {string} status
 * @property {string} statusDetail
 * @property {'signed'|'rail'} kind
 * @property {Object} evidence
 */

const expectedSteps = ['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM'];
const copy = Object.freeze({
  OFFER: ['Agent A', 'made an offer', 'The exact signed offer is visible on the configured venue.'],
  ACCEPT: ['Agent B', 'accepted the terms', 'The exact signed acceptance is visible on the configured venue.'],
  LOCK: ['Agent A', 'locked the deal', 'The exact signed lock record is visible in the deal room.'],
  RAIL_LOCK: ['BLACKBOX', 'verified rail lock evidence', 'A local write receipt is paired with a later exact public read.'],
  REVEAL: ['Agent B', 'revealed the deal', 'The exact signed reveal record is visible in the deal room.'],
  RAIL_CLAIM: ['BLACKBOX', 'verified claim evidence', 'A local write receipt is paired with a later exact public read.'],
});

function assertCapsule(capsule) {
  if (!capsule || capsule.schema !== 'tclk-blackbox/public-evidence-capsule/v1'
    || capsule.lineageId !== 'phase3b-final' || capsule.status.complete !== true
    || capsule.summary.totalSteps !== 6 || capsule.summary.verifiedSteps !== 6
    || capsule.summary.unresolvedSteps !== 0 || capsule.flightRecord?.length !== 6
    || JSON.stringify(capsule.flightRecord.map(item => item.step)) !== JSON.stringify(expectedSteps)) {
    throw new TypeError('Unsupported BLACKBOX public evidence capsule');
  }
}

function signedFields(evidence) {
  return [
    ['Actor DID', evidence.did], ['Room', evidence.room], ['Signed nonce', String(evidence.signedNonce)],
    ['Public sequence', String(evidence.publicSeq)], ['Public timestamp', evidence.publicTimestamp],
    ['Canonical text SHA-256', evidence.canonicalTextSha256], ['Signature present', evidence.signatureSeen ? 'Yes' : 'No'],
    ['Observation', evidence.classification], ['Public source', evidence.observationSource],
  ];
}

function railFields(evidence) {
  return [
    ['Namespace / key', `${evidence.namespace} / ${evidence.key}`], ['Receipt SHA-256', evidence.receiptSha256],
    ['Expected value SHA-256', evidence.expectedValueSha256], ['Observed value SHA-256', evidence.observedValueSha256],
    ['Exact value match', evidence.exactValueMatch ? 'Yes' : 'No'], ['Receipt time', evidence.receiptWrittenAt],
    ['Public observation time', evidence.observedAt], ['Observation', evidence.classification],
  ];
}

function assertPublicSafe(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:secret|preimage|privateKey|signerSecret|passphrase|seed|localPath)$/i.test(key)) throw new TypeError('Private field refused in public flight record');
    assertPublicSafe(child);
  }
}

function hubSignedFields(evidence) {
  return [
    ['Actor DID', evidence.did], ['Signed nonce', String(evidence.signedNonce)],
    ['Public sequence', String(evidence.publicSeq)], ['Public timestamp', evidence.publicTimestamp],
    ['Canonical text SHA-256', evidence.canonicalTextSha256], ['Exact public matches', String(evidence.exactMatchCount)],
    ['Observation', evidence.classification], ['Public source', evidence.observationSource],
  ];
}

function hubRailFields(capsule, evidence) {
  return [
    ['Namespace / key', `${capsule.deal.paperRail.namespace} / ${capsule.deal.paperRail.key}`], ['Receipt SHA-256', evidence.receiptSha256],
    ['Expected value SHA-256', evidence.expectedValueSha256], ['Observed value SHA-256', evidence.observedValueSha256],
    ['Exact value match', evidence.exactValueMatch ? 'Yes' : 'No'], ['Receipt time', evidence.writtenAt],
    ['Public observation time', evidence.observedAt], ['Observation', evidence.classification],
  ];
}

export function createFlightRecorderModel(capsule) {
  assertCapsule(capsule);
  const steps = capsule.flightRecord.map(item => {
    const kind = item.step.startsWith('RAIL_') ? 'rail' : 'signed';
    const [actor, action, statusDetail] = copy[item.step];
    return Object.freeze({
      operationId: item.operationId,
      code: item.step,
      label: item.display.label,
      actor,
      action,
      status: item.display.verification,
      statusDetail,
      kind,
      timestamp: kind === 'rail' ? item.evidence.observedAt : item.evidence.publicTimestamp,
      evidence: item.evidence,
      fields: kind === 'rail' ? railFields(item.evidence) : signedFields(item.evidence),
    });
  });
  return Object.freeze({
    product: capsule.product,
    capsule,
    capsuleSha256: '8337b483c26bd4cb06c12b3a5e9523d595a0a2d023acd1923eebb263d03ccc02',
    status: capsule.status.complete ? 'Complete' : 'Incomplete',
    summary: capsule.summary,
    deal: Object.freeze({ ...capsule.deal, venueHost: new URL(capsule.deal.venueOrigin).host }),
    trust: capsule.trustModel,
    policy: capsule.evidencePolicy,
    steps,
  });
}

export function createHubFlightRecorderModel(capsule, capsuleSha256) {
  assertPublicSafe(capsule);
  if (!capsule || capsule.schema !== 'tclk-blackbox/public-deal-capsule/v1' || capsule.complete !== true
    || !/^bbx-[0-9a-f]{16}$/.test(capsule.sessionId) || !/^[0-9a-f]{64}$/.test(capsuleSha256)
    || capsule.operations?.length !== 6 || capsule.operations.some(item => item.state !== 'COMPLETE')
    || JSON.stringify(capsule.operations.map(item => item.step)) !== JSON.stringify(expectedSteps)) {
    throw new TypeError('Unsupported Hub public flight record');
  }
  const didA = capsule.operations.find(item => item.step === 'OFFER')?.evidence.did;
  const didB = capsule.operations.find(item => item.step === 'ACCEPT')?.evidence.did;
  if (!didA || !didB || didA === didB) throw new TypeError('Hub identity map invalid');
  const steps = capsule.operations.map(item => {
    const kind = item.step.startsWith('RAIL_') ? 'rail' : 'signed'; const [actor, action, statusDetail] = copy[item.step];
    return Object.freeze({ operationId: item.operationId, code: item.step, label: item.step.replace('_', ' '), actor, action,
      status: kind === 'rail' ? 'Receipt and public observation verified' : 'Publicly verified', statusDetail, kind,
      timestamp: kind === 'rail' ? item.evidence.observedAt : item.evidence.publicTimestamp, evidence: item.evidence,
      fields: kind === 'rail' ? hubRailFields(capsule, item.evidence) : hubSignedFields(item.evidence) });
  });
  return Object.freeze({ product: 'TCLK BLACKBOX', capsule, capsuleSha256, sourceKind: 'HUB_CREATED_LOCAL_RECORD', status: 'Complete',
    summary: Object.freeze({ totalSteps: 6, verifiedSteps: 6, unresolvedSteps: 0 }),
    deal: Object.freeze({ lineageId: capsule.sessionId, contractId: capsule.deal.contractId, venueOrigin: capsule.venueOrigin,
      venueHost: new URL(capsule.venueOrigin).host, manifestRoot: capsule.manifestRoot, dealRoom: capsule.deal.dealRoom }),
    trust: Object.freeze({ operatorModel: capsule.operatorModel, sameHumanOperator: true, independentHumanCounterparty: false, didA, didB }),
    policy: Object.freeze({ completionRule: 'All six operations require exact recorded evidence.' }), steps });
}
