import { createHash, verify as edVerify } from 'node:crypto';
import { publicKeyFromDidKey } from '../../airlock/signer.mjs';
import { acquireOneShotAttempt, budgetIdentity } from '../../airlock/attempt-budget.mjs';
import { artifactCommitment, buildAssertion, canonicalJson, normalizeVenueOrigin, operationIdentity, parseAssertionText, requireNonce, sha256, signApprovalCandidate, signaturePreimage, submitApprovalCandidate } from './canonical.mjs';
import { observeExport } from './observer.mjs';

const draftId = value => `w2draft1-${createHash('sha256').update(Buffer.concat([Buffer.from('BLACKBOX::W2::DRAFT::v1'), Buffer.from([0]), Buffer.from(canonicalJson(value))])).digest('hex')}`;
const iso = value => new Date(value).toISOString();
const event = (state, type, at, detail = {}) => { state.events.push({ type, at, ...detail }); return state; };

function assertW1Record(record) {
  if (record?.schema !== 'tclk-blackbox/local-validation-flight-record/v1' || record.executionType !== 'LOCAL_VALIDATION'
    || record.readOnly !== true || record.publication !== 'NONE' || record.transportStates?.length !== 0) throw new Error('W1_RECORD_NOT_ELIGIBLE');
  return record.artifact;
}

function verifySignature(operation) {
  try { return edVerify(null, Buffer.from(signaturePreimage(operation.room, operation.nonce, operation.signedText)), publicKeyFromDidKey(operation.signerDid), Buffer.from(operation.signature, 'base64url')); } catch { return false; }
}

export class W2PublicationService {
  constructor({ store, custody, transport, observerFetch, signApproval, submitApproval, submitBudgetRoot, readW1Record, now = () => Date.now() }) {
    this.store = store; this.custody = custody; this.transport = transport; this.observerFetch = observerFetch;
    this.signApproval = signApproval; this.submitApproval = submitApproval; this.submitBudgetRoot = submitBudgetRoot;
    this.readW1Record = readW1Record; this.now = now;
  }

  async assertW1Link(state) {
    if (artifactCommitment(state.w1Artifact) !== state.evidenceArtifactSha256 || !this.readW1Record) throw new Error('W2_W1_LINK_INVALID');
    const current = await this.readW1Record(state.recordId);
    if (current.recordId !== state.recordId || artifactCommitment(assertW1Record(current)) !== state.evidenceArtifactSha256) throw new Error('W2_W1_LINK_CHANGED');
    const built = buildAssertion(current.artifact, state.venueOrigin);
    if (built.signedText !== state.signedText || built.signedTextSha256 !== state.signedTextSha256 || built.assertionHash !== state.assertionHash
      || operationIdentity(state).operationId !== state.operationId) throw new Error('W2_OPERATION_BINDING_INVALID');
    const draft = { evidenceArtifactSha256: state.evidenceArtifactSha256, room: state.room, signerDid: state.signerDid,
      signedTextSha256: state.signedTextSha256, venueOrigin: state.venueOrigin };
    const generation = state.reservation?.generation ?? 1;
    if (state.reservation?.requestId !== draftId(draft) || state.reservation.nonce !== state.nonce
      || !Number.isSafeInteger(generation) || generation < 1) throw new Error('W2_RESERVATION_BINDING_INVALID');
    const expectedSign = signApprovalCandidate(state, { issuedAt: state.signApproval.candidate.approvalIssuedAt,
      expiresAt: state.signApproval.candidate.approvalExpiresAt });
    if (canonicalJson(expectedSign.candidate) !== canonicalJson(state.signApproval.candidate)
      || expectedSign.approvalHash !== state.signApproval.approvalHash || expectedSign.phrase !== state.signApproval.phrase) throw new Error('W2_SIGN_APPROVAL_BINDING_INVALID');
  }

  async prepare(record, { venueOrigin, room, signerDid }) {
    const artifact = assertW1Record(record); const built = buildAssertion(artifact, venueOrigin);
    const draftBinding = { evidenceArtifactSha256: built.assertion.evidenceArtifactSha256, room, signerDid, signedTextSha256: built.signedTextSha256, venueOrigin: normalizeVenueOrigin(venueOrigin) };
    operationIdentity({ ...draftBinding, nonce: '1' }); // validate room and DID before custody burns a nonce
    const requestId = draftId(draftBinding); const reservation = await this.custody.reserve({ requestId, room, signerDid,
      venueOrigin: draftBinding.venueOrigin, signedTextSha256: draftBinding.signedTextSha256 });
    requireNonce(reservation.nonce); if (reservation.state !== 'RESERVED' || reservation.requestId !== requestId || reservation.room !== room || reservation.signerDid !== signerDid
      || reservation.venueOrigin !== draftBinding.venueOrigin || !Number.isSafeInteger(reservation.generation ?? 1)
      || (reservation.generation ?? 1) < 1) throw new Error('CUSTODY_RESERVATION_MISMATCH');
    const identity = operationIdentity({ ...draftBinding, nonce: reservation.nonce }); const createdAt = iso(this.now()); const expiresAt = iso(this.now() + 15 * 60 * 1000);
    const operation = { ...draftBinding, ...identity, nonce: reservation.nonce, signedText: built.signedText, assertion: built.assertion, assertionHash: built.assertionHash, w1Artifact: artifact,
      recordId: record.recordId, createdAt, reservation, binding: { requestId, ...identity.core } };
    const approval = signApprovalCandidate(operation, { issuedAt: createdAt, expiresAt }); operation.signApproval = { ...approval, status: 'PENDING' };
    return this.store.create(operation);
  }

  async approveAndSign(operationId) {
    const spent = await this.store.update(operationId, async state => {
      await this.assertW1Link(state);
      if (state.state !== 'APPROVAL_PENDING' || state.signBudget !== 'AVAILABLE') throw new Error('SIGN_NOT_AVAILABLE');
      if (this.now() > Date.parse(state.signApproval.candidate.approvalExpiresAt)) {
        const canceled = await this.custody.cancelReserved({ requestId: state.reservation.requestId, operationId: state.operationId,
          signerDid: state.signerDid, nonce: state.nonce, approvalCandidate: state.signApproval.candidate,
          approvalHash: state.signApproval.approvalHash, reason: 'EXPIRED' });
        if (canceled.state !== 'BURNED' || canceled.operationId !== state.operationId || canceled.nonce !== state.nonce) throw new Error('CUSTODY_CANCELLATION_MISMATCH');
        state.state = 'CANCELLED_NONCE_BURNED'; state.signApproval.status = 'EXPIRED'; return event(state, 'APPROVAL_EXPIRED', iso(this.now()));
      }
      const candidate = structuredClone(state.signApproval.candidate);
      const phrase = await this.signApproval({ candidate, approvalHash: state.signApproval.approvalHash, expectedPhrase: state.signApproval.phrase });
      if (canonicalJson(candidate) !== canonicalJson(state.signApproval.candidate)) throw new Error('APPROVAL_INVALIDATED');
      if (phrase !== state.signApproval.phrase) throw new Error('APPROVAL_PHRASE_INVALID');
      state.signApproval.status = 'CONSUMED'; state.signApproval.decidedAt = iso(this.now()); state.signBudget = 'SPENT'; state.state = 'SIGNING_OUTCOME_UNCERTAIN';
      return event(state, 'SIGN_APPROVAL_CONSUMED', state.signApproval.decidedAt);
    });
    if (spent.state === 'CANCELLED_NONCE_BURNED') return spent;
    let signed; try { signed = await this.custody.signReserved({ requestId: spent.reservation.requestId, room: spent.room, signerDid: spent.signerDid,
      nonce: spent.nonce, signedText: spent.signedText, approvalCandidate: spent.signApproval.candidate,
      approvalHash: spent.signApproval.approvalHash, operationId: spent.operationId }); }
    catch { return this.store.update(operationId, state => event(state, 'SIGNING_OUTCOME_UNCERTAIN', iso(this.now()))); }
    return this.store.update(operationId, state => {
      if (state.signBudget !== 'SPENT' || state.state !== 'SIGNING_OUTCOME_UNCERTAIN') throw new Error('SIGN_STATE_INVALID');
      if (signed.did !== state.signerDid || signed.room !== state.room || signed.nonce !== state.nonce || signed.text !== state.signedText) {
        return event(state, 'SIGNER_RESPONSE_MISMATCH', iso(this.now()));
      }
      state.signature = signed.signature; if (!verifySignature(state)) { delete state.signature; return event(state, 'SIGNER_RESPONSE_INVALID', iso(this.now())); }
      state.state = 'SIGNED'; state.submitApproval = { ...submitApprovalCandidate(state), status: 'PENDING' }; return event(state, 'SIGNED', iso(this.now()));
    });
  }

  async submitOnce(operationId) {
    const spent = await this.store.update(operationId, async state => {
      await this.assertW1Link(state);
      if (!state.signature || !verifySignature(state)) throw new Error('W2_SIGNED_OPERATION_INVALID');
      const expectedSubmit = submitApprovalCandidate(state);
      if (canonicalJson(expectedSubmit.candidate) !== canonicalJson(state.submitApproval?.candidate)
        || canonicalJson(expectedSubmit.body) !== canonicalJson(state.submitApproval?.body)
        || expectedSubmit.approvalHash !== state.submitApproval?.approvalHash || expectedSubmit.phrase !== state.submitApproval?.phrase) throw new Error('W2_SUBMIT_APPROVAL_BINDING_INVALID');
      if (state.state !== 'SIGNED' && state.state !== 'SIGNED_NOT_SUBMITTED') throw new Error('SUBMIT_NOT_AVAILABLE');
      if (state.submitBudget !== 'AVAILABLE') throw new Error('SUBMIT_BUDGET_SPENT');
      const candidate = structuredClone(state.submitApproval.candidate);
      return Promise.resolve(this.submitApproval({ candidate, approvalHash: state.submitApproval.approvalHash, expectedPhrase: state.submitApproval.phrase })).then(phrase => {
      if (canonicalJson(candidate) !== canonicalJson(state.submitApproval.candidate)) throw new Error('SUBMIT_APPROVAL_INVALIDATED');
      if (phrase !== state.submitApproval.phrase) throw new Error('SUBMIT_APPROVAL_PHRASE_INVALID');
      const assertion = parseAssertionText(state.signedText); const endpoint = new URL(state.submitApproval.candidate.endpoint);
      if (assertion.venueOrigin !== state.venueOrigin || endpoint.origin !== state.venueOrigin || normalizeVenueOrigin(endpoint.origin) !== state.venueOrigin) throw new Error('VENUE_BINDING_MISMATCH');
      state.submitBudget = 'SPENT'; state.submitApproval.status = 'CONSUMED'; state.state = 'SUBMISSION_UNCERTAIN';
      state.submission = { attemptId: state.submitApproval.candidate.attemptId, automaticRetries: 0, postCalls: 0,
        classification: 'SUBMISSION_UNCERTAIN', startedAt: iso(this.now()), endpoint: state.submitApproval.candidate.endpoint,
        requestBodySha256: state.submitApproval.candidate.requestBodySha256 };
      return event(state, 'SUBMISSION_STARTED', state.submission.startedAt);
      });
    });
    try {
      if (!this.submitBudgetRoot) throw new Error('W2_DURABLE_SUBMIT_BUDGET_REQUIRED');
      acquireOneShotAttempt(budgetIdentity({ purpose: 'W2_SUBMIT', operationClass: 'TECHNOCORE_ROOM_POST', subject: spent.operationId }),
        { root: this.submitBudgetRoot });
    } catch {
      return this.store.update(operationId, state => { state.state = 'SUBMISSION_UNCERTAIN'; state.submission.classification = 'SUBMISSION_UNCERTAIN';
        state.submission.diagnostic = 'DURABLE_BUDGET_REFUSED'; state.submission.finishedAt = iso(this.now());
        return event(state, 'SUBMISSION_UNCERTAIN', state.submission.finishedAt); });
    }
    let result; try { result = await this.transport.post({ endpoint: spent.submission.endpoint, body: spent.submitApproval.body, redirect: 'error', retries: 0 }); }
    catch (error) { result = { kind: 'NETWORK_ERROR', diagnostic: error?.code ?? 'NETWORK_ERROR' }; }
    return this.store.update(operationId, state => {
      state.submission.postCalls = 1; state.submission.finishedAt = iso(this.now());
      const status = result?.status;
      if (Number.isInteger(status) && status >= 400 && status < 500) { state.state = 'REJECTED'; state.submission.classification = 'REJECTED'; }
      else if (Number.isInteger(status) && status >= 200 && status < 300 && result.posted
        && result.posted.did === state.signerDid && typeof result.posted.nonce === 'string' && result.posted.nonce === state.nonce && result.posted.text === state.signedText && result.posted.sig === state.signature) {
        state.state = 'ACK_RECEIVED'; state.submission.classification = 'ACK_RECEIVED';
      } else { state.state = 'SUBMISSION_UNCERTAIN'; state.submission.classification = 'SUBMISSION_UNCERTAIN'; }
      state.submission.httpStatus = Number.isInteger(status) ? status : null;
      state.submission.responseBodySha256 = /^sha256:[0-9a-f]{64}$/.test(result?.responseBodySha256 ?? '') ? result.responseBodySha256 : null;
      state.submission.diagnostic = String(result?.diagnostic ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 256);
      return event(state, state.submission.classification, state.submission.finishedAt);
    });
  }

  async observe(operationId) {
    const state = await this.store.read(operationId); if (!state.signature || state.submitBudget !== 'SPENT') throw new Error('OBSERVATION_NOT_AVAILABLE');
    await this.assertW1Link(state); if (!verifySignature(state)) throw new Error('W2_SIGNED_OPERATION_INVALID');
    const response = await this.observerFetch({ venueOrigin: state.venueOrigin, room: state.room, redirect: 'error' });
    const observation = observeExport(response.bytes, { room: state.room, venueOrigin: response.origin, operation: state, generation: response.generation ?? null });
    return this.store.update(operationId, async next => {
      await this.assertW1Link(next);
      next.observations ??= []; next.observations.push({ ...observation, observedAt: iso(this.now()) });
      next.duplicateMatchAnomaly = observation.anomaly;
      if (observation.classification === 'OBSERVED_PUBLIC') next.state = artifactCommitment(next.w1Artifact) === next.evidenceArtifactSha256 ? 'COMPLETE' : 'OBSERVED_PUBLIC';
      return event(next, observation.classification, iso(this.now()), { exactMatchCount: observation.exactMatchCount, anomaly: observation.anomaly });
    });
  }

  async cancel(operationId) {
    return this.store.update(operationId, async state => {
      if (state.state === 'CANCELLED_NONCE_BURNED' && state.signApproval?.status === 'CANCELLED') return null;
      if (state.state !== 'APPROVAL_PENDING' || state.signBudget !== 'AVAILABLE' || state.submitBudget !== 'AVAILABLE') throw new Error('W2_CANCEL_AFTER_SIGNING_REFUSED');
      const canceled = await this.custody.cancelReserved({ requestId: state.reservation.requestId, operationId: state.operationId,
        signerDid: state.signerDid, nonce: state.nonce, approvalCandidate: state.signApproval.candidate,
        approvalHash: state.signApproval.approvalHash, reason: 'CANCELLED' });
      if (canceled.state !== 'BURNED' || canceled.operationId !== state.operationId || canceled.signerDid !== state.signerDid
        || canceled.nonce !== state.nonce || canceled.auditEvent !== 'CANCELED_BEFORE_SIGNING') throw new Error('CUSTODY_CANCELLATION_MISMATCH');
      state.state = 'CANCELLED_NONCE_BURNED'; state.signApproval.status = 'CANCELLED';
      return event(state, 'CANCELED_BEFORE_SIGNING', iso(this.now()), { requestId: state.reservation.requestId, operationId });
    });
  }

  async inspect(operationId) { return this.store.read(operationId); }
}

export function publicSafePublication(state) {
  const submission = state.submission ? { attemptId: state.submission.attemptId, requestBodySha256: state.submission.requestBodySha256,
    automaticRetries: state.submission.automaticRetries, postCalls: state.submission.postCalls,
    startedAt: state.submission.startedAt, finishedAt: state.submission.finishedAt ?? null,
    httpStatus: state.submission.httpStatus ?? null, responseBodySha256: state.submission.responseBodySha256 ?? null,
    classification: state.submission.classification ?? 'SUBMISSION_UNCERTAIN' } : null;
  return { schema: 'blackbox/w2-publication-evidence/v1', operationId: state.operationId, recordId: state.recordId,
    w1EvidenceArtifactSha256: state.evidenceArtifactSha256, assertion: state.assertion, assertionHash: state.assertionHash,
    signerDid: state.signerDid, nonce: state.nonce, signature: state.signature ?? null, targetVenue: state.venueOrigin, targetRoomPublicLabel: 'REDACTED',
    approvalHash: state.signApproval.approvalHash, signedOperationSha256: state.submitApproval?.candidate?.signedOperationSha256 ?? null,
    attemptBudget: state.submitBudget, submission, observations: state.observations ?? [], state: state.state,
    duplicateMatchAnomaly: state.duplicateMatchAnomaly ?? null, limitations: ['ROOM_REDACTED_EXTERNAL_VERIFICATION_REQUIRES_ROOM', 'SELF_PUBLISHED', 'VENUE_METADATA_UNSIGNED', 'RETENTION_NOT_GUARANTEED'] };
}
