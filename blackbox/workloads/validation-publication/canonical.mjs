import { createHash } from 'node:crypto';

export const ASSERTION_SCHEMA = 'blackbox/validation-result-assertion/v1';
export const SIGN_APPROVAL_SCHEMA = 'blackbox/w2-sign-approval/v1';
export const SUBMIT_APPROVAL_SCHEMA = 'blackbox/w2-submit-approval/v1';
export const ASSERTION_PREFIX = 'blackbox-w2 ';
export const NONCE_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
export const ROOM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const LIMITATIONS = Object.freeze(['NO_ECONOMIC_OR_REWARD_CLAIM', 'NOT_INDEPENDENT_CONTRIBUTION_PROOF', 'ROOM_REDACTED', 'SELF_PUBLISHED', 'SUPPLIED_WINDOW_ONLY']);
const HEX = /^[0-9a-f]{64}$/; const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const ascii = value => typeof value === 'string' && /^[\x20-\x7e]*$/.test(value);

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('CANONICAL_NUMBER_REFUSED');
    return String(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) throw new Error('CANONICAL_SPARSE_ARRAY_REFUSED');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (!plain(value)) throw new Error('CANONICAL_VALUE_REFUSED');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function normalizeVenueOrigin(value) {
  if (!ascii(value)) throw new Error('VENUE_ORIGIN_INVALID');
  let url; try { url = new URL(value); } catch { throw new Error('VENUE_ORIGIN_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('VENUE_ORIGIN_INVALID');
  const origin = url.origin.toLowerCase();
  if (origin !== value) throw new Error('VENUE_ORIGIN_NOT_CANONICAL');
  return origin;
}

export function requireNonce(value, { allowZero = true } = {}) {
  if (typeof value !== 'string' || !NONCE_PATTERN.test(value) || (!allowZero && value === '0')) throw new Error('NONCE_NOT_CANONICAL');
  return value;
}

export function artifactCommitment(artifact) {
  if (!plain(artifact) || artifact.schema !== 'blackbox/workload-evidence/v1') throw new Error('W1_ARTIFACT_INVALID');
  return sha(Buffer.from(canonicalJson(artifact), 'utf8'));
}

function generationFrom(coverage) {
  const item = coverage?.generation;
  if (item?.status === 'UNKNOWN' && item.source === 'NONE' && Object.keys(item).length === 2) return { source: 'NONE', status: 'UNKNOWN' };
  if (item?.status === 'KNOWN' && item.source === 'SUPPLIED_HEADER' && requireNonce(item.value) && Object.keys(item).length === 3) return { source: 'SUPPLIED_HEADER', status: 'KNOWN', value: item.value };
  throw new Error('W1_GENERATION_INVALID');
}

export function buildAssertion(artifact, venueOrigin) {
  const venue = normalizeVenueOrigin(venueOrigin);
  if (!HEX.test(artifact?.workloadId ?? '') || !HEX.test(artifact?.input?.sha256 ?? '')
    || !['VALID', 'INVALID', 'INDETERMINATE'].includes(artifact?.verdict)
    || artifact?.coverage?.scope !== 'SUPPLIED_WINDOW_ONLY' || artifact?.coverage?.historyCompleteness !== 'NOT_PROVEN'
    || typeof artifact?.coverage?.windowStatus !== 'string' || !ascii(artifact.coverage.windowStatus)
    || artifact?.verifier?.id !== 'technocore-transcript-validation/v1'
    || artifact?.verifier?.checkProfile !== 'tc-export-signed-rows/v1'
    || !/^sha256:[0-9a-f]{64}$/.test(artifact?.verifier?.implementationDigest ?? '')) throw new Error('W1_ARTIFACT_NOT_PUBLISHABLE');
  const assertion = {
    assertionType: 'W1_VALIDATION_RESULT',
    coverage: { generation: generationFrom(artifact.coverage), historyCompleteness: 'NOT_PROVEN', scope: 'SUPPLIED_WINDOW_ONLY', windowStatus: artifact.coverage.windowStatus },
    evidenceArtifactSha256: artifactCommitment(artifact), inputSha256: artifact.input.sha256,
    limitations: [...LIMITATIONS], schema: ASSERTION_SCHEMA, venueOrigin: venue, verdict: artifact.verdict,
    verifier: { checkProfile: artifact.verifier.checkProfile, id: artifact.verifier.id, implementationDigest: artifact.verifier.implementationDigest },
    workloadId: artifact.workloadId,
  };
  const text = `${ASSERTION_PREFIX}${canonicalJson(assertion)}`;
  if (!ascii(text) || [...text].length > 4096 || text.trim() !== text) throw new Error('ASSERTION_TEXT_INVALID');
  return Object.freeze({ assertion: Object.freeze(assertion), signedText: text, assertionHash: sha(Buffer.from(canonicalJson(assertion))), signedTextSha256: sha(Buffer.from(text)) });
}

export function parseAssertionText(text) {
  if (typeof text !== 'string' || !text.startsWith(ASSERTION_PREFIX)) throw new Error('ASSERTION_PREFIX_INVALID');
  let parsed; try { parsed = JSON.parse(text.slice(ASSERTION_PREFIX.length)); } catch { throw new Error('ASSERTION_JSON_INVALID'); }
  const expected = ['assertionType', 'coverage', 'evidenceArtifactSha256', 'inputSha256', 'limitations', 'schema', 'venueOrigin', 'verdict', 'verifier', 'workloadId'];
  if (!plain(parsed) || Object.keys(parsed).sort().join('|') !== expected.sort().join('|') || `${ASSERTION_PREFIX}${canonicalJson(parsed)}` !== text) throw new Error('ASSERTION_SCHEMA_CLOSED');
  normalizeVenueOrigin(parsed.venueOrigin);
  return parsed;
}

export function signaturePreimage(room, nonce, signedText) {
  if (!ROOM_PATTERN.test(room ?? '')) throw new Error('ROOM_INVALID'); requireNonce(nonce);
  if (typeof signedText !== 'string' || signedText.trim() !== signedText) throw new Error('SIGNED_TEXT_INVALID');
  return `${room}|${nonce}|${signedText}`;
}

export function operationIdentity({ evidenceArtifactSha256, nonce, room, signedTextSha256, signerDid, venueOrigin }) {
  requireNonce(nonce); if (!ROOM_PATTERN.test(room ?? '') || !DID.test(signerDid ?? '')) throw new Error('OPERATION_BINDING_INVALID');
  const core = { assertionSchema: ASSERTION_SCHEMA, evidenceArtifactSha256, nonce, room, signedTextSha256, signerDid, venueOrigin: normalizeVenueOrigin(venueOrigin) };
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('BLACKBOX::W2::OPERATION::v1'), Buffer.from([0]), Buffer.from(canonicalJson(core))])).digest('hex');
  return Object.freeze({ core: Object.freeze(core), operationId: `w2op1-${digest}` });
}

export function signApprovalCandidate(operation, { issuedAt, expiresAt }) {
  const candidate = { action: 'CREATE_DETACHED_SIGNATURE_ONLY', approvalExpiresAt: expiresAt, approvalIssuedAt: issuedAt,
    evidenceArtifactSha256: operation.evidenceArtifactSha256, nonce: operation.nonce, operationId: operation.operationId,
    schema: SIGN_APPROVAL_SCHEMA, signaturePreimageSha256: sha(Buffer.from(signaturePreimage(operation.room, operation.nonce, operation.signedText))),
    signedText: operation.signedText, signedTextSha256: operation.signedTextSha256, signerDid: operation.signerDid,
    targetRoom: operation.room, targetVenueOrigin: operation.venueOrigin };
  const hash = sha(Buffer.concat([Buffer.from('BLACKBOX::W2::SIGN_APPROVAL::v1'), Buffer.from([0]), Buffer.from(canonicalJson(candidate))]));
  return Object.freeze({ candidate: Object.freeze(candidate), approvalHash: hash, phrase: `SIGN W2 ONCE ${hash.slice(-8).toUpperCase()}` });
}

export function submitApprovalCandidate(operation) {
  const endpoint = `${operation.venueOrigin}/r/${encodeURIComponent(operation.room)}?format=json`;
  const body = { did: operation.signerDid, sig: operation.signature, nonce: operation.nonce, text: operation.signedText };
  const signedOperationSha256 = sha(Buffer.from(canonicalJson(body)));
  const candidate = { action: 'POST_EXACT_SIGNED_OPERATION_ONCE', attemptId: `${operation.operationId}/submit-attempt-1`, endpoint,
    operationId: operation.operationId, requestBodySha256: sha(Buffer.from(JSON.stringify(body))), schema: SUBMIT_APPROVAL_SCHEMA,
    signedOperationSha256, warning: 'ONE POST; NO RETRY' };
  const approvalHash = sha(Buffer.from(canonicalJson(candidate)));
  return Object.freeze({ body: Object.freeze(body), candidate: Object.freeze(candidate), approvalHash, phrase: `POST W2 ONCE ${approvalHash.slice(-8).toUpperCase()}` });
}

export const sha256 = sha;
