import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { tclk } from '../../lab/upstream.mjs';
import { acquireOneShotAttempt, budgetIdentity } from '../airlock/attempt-budget.mjs';
import { invokeRealDetachedBridge } from '../airlock/detached-bridge.mjs';
import { buildRequest } from '../airlock/envelope.mjs';
import { promptHumanOperator } from '../airlock/operator-approval.mjs';
import { prepareFrame } from '../airlock/prepare.mjs';
import { canonicalMessage, verifyEd25519 } from '../airlock/signer.mjs';
import { DEFAULT_VENUE, HUB_ROOT, readSecret } from './session.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bounded = value => Buffer.from(value ?? '', 'utf8').subarray(0, 2048).toString('utf8')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]')
  .replace(/\bxprv[A-Za-z0-9]{20,}\b/g, '[REDACTED]').replace(/[\u0000-\u001f\u007f]/g, '?');

export function exactPublicMatch(record, value) {
  const rows = Array.isArray(value) ? value.flatMap(item => exactPublicMatchRows(item)) : exactPublicMatchRows(value);
  const matches = rows.filter(item => (item.did ?? item.from) === record.did && Number(item.nonce ?? item.signedNonce) === record.nonce
    && typeof item.text === 'string' && sha256(item.text) === sha256(record.text) && (!item.room || item.room === record.room));
  const found = matches[0]; return { exactMatchCount: matches.length, publicSeq: found?.seq ?? null,
    publicTimestamp: found?.ts ?? found?.timestamp ?? null, signatureSeen: typeof (found?.sig ?? found?.signature) === 'string' };
}
function exactPublicMatchRows(value) {
  if (!value || typeof value !== 'object') return [];
  return [...((Object.hasOwn(value, 'text') && (Object.hasOwn(value, 'did') || Object.hasOwn(value, 'from'))) ? [value] : []),
    ...Object.values(value).flatMap(item => exactPublicMatchRows(item))];
}

async function terminalApproval(label, fingerprint, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (stdin.isTTY !== true || stdout.isTTY !== true) throw new Error('LOCAL_INTERACTIVE_APPROVAL_REQUIRED');
  const phrase = `${label} ONCE ${fingerprint.slice(-6).toUpperCase()}`; stdout.write(`\nType exactly: ${phrase}\nApproval: `);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try { const entered = await new Promise(resolveLine => rl.once('line', line => resolveLine(line.trim()))); return entered === phrase; }
  finally { rl.close(); }
}

export class RealExecutor {
  constructor({ root = HUB_ROOT, transport = globalThis.fetch, signBridge = invokeRealDetachedBridge,
    approveSign = promptHumanOperator, approveAction = terminalApproval } = {}) {
    this.root = root; this.transport = transport; this.signBridge = signBridge; this.approveSign = approveSign; this.approveAction = approveAction;
  }
  directory(session) { return resolve(this.root, 'sessions', session.id, 'artifacts'); }
  artifact(session, operation, suffix) { return resolve(this.directory(session), `${operation.id}-${suffix}.json`); }
  budgetRoot(session) { return resolve(this.root, 'sessions', session.id, 'attempt-budgets'); }

  async frame(session, operation) {
    if (operation.step !== 'REVEAL') return operation.frame;
    return { ...operation.frame, secret: await readSecret(session.id, { root: this.root }) };
  }
  async railValue(session, operation) {
    const locked = { status: 'locked', lock: 'hash', statement: session.deal.dealCommitment, refundAfterMs: session.deal.refundAfterMs };
    return tclk.encodePaperRecord(operation.step === 'RAIL_LOCK' ? locked : { ...locked, status: 'claimed', secret: await readSecret(session.id, { root: this.root }) });
  }
  async publicRead(session, operation) {
    const endpoint = `${session.venueOrigin}/kv/${encodeURIComponent(session.deal.paperRail.namespace)}/${encodeURIComponent(session.deal.paperRail.key)}`;
    let response; try { response = await this.transport(endpoint, { method: 'GET', headers: { accept: 'text/plain' }, credentials: 'omit', redirect: 'error' }); }
    catch (error) { return { classification: 'PUBLIC_READ_INVALID', diagnostic: bounded(error?.code ?? error?.name) }; }
    const body = await response.text();
    if (response.status === 404) return { classification: 'KEY_VACANT', endpoint, valueHash: null };
    if (response.status !== 200 || Buffer.byteLength(body) > 65536) return { classification: 'PUBLIC_READ_INVALID', diagnostic: bounded(body) };
    const lines = body.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('!!'));
    return lines.length === 1 ? { classification: 'KEY_OCCUPIED', endpoint, value: lines[0], valueHash: sha256(lines[0]) }
      : { classification: 'PUBLIC_READ_INVALID', diagnostic: 'Unexpected public value shape' };
  }

  async prepare({ session, operation, action }) {
    await mkdir(this.directory(session), { recursive: true, mode: 0o700 });
    let privateReview; let publicReview;
    if (action === 'SIGN') {
      const prepared = prepareFrame(await this.frame(session, operation)); const request = buildRequest(prepared, { createdAt: new Date().toISOString() });
      privateReview = { action, request, room: prepared.intendedRoom, text: prepared.canonicalPayload, expectedSignerDid: prepared.signerDid };
      publicReview = { action, operationId: operation.id, actor: operation.actor, room: prepared.intendedRoom,
        signerDid: prepared.signerDid, canonicalHash: prepared.canonicalHash, statement: 'Signature remains local and does not submit.' };
    } else if (action === 'SUBMIT' || action === 'RECOVERY_SUBMIT') {
      const signed = JSON.parse(await readFile(this.artifact(session, operation, 'signed'), 'utf8'));
      const endpoint = `${session.venueOrigin}/r/${encodeURIComponent(signed.room)}?format=json`;
      const body = JSON.stringify({ did: signed.did, sig: signed.signature, nonce: String(signed.nonce), text: signed.text });
      privateReview = { action, endpoint, body, signedSha256: sha256(JSON.stringify(signed)) };
      publicReview = { action, operationId: operation.id, endpoint, requestBodySha256: sha256(body),
        statement: action === 'RECOVERY_SUBMIT' ? 'Reuses the existing signed operation once; never re-signs.' : 'At most one POST; no automatic retry.' };
    } else {
      const value = await this.railValue(session, operation); const current = await this.publicRead(session, operation);
      const previous = operation.step === 'RAIL_CLAIM' ? await this.railValue(session, session.operations[3]) : null;
      const eligible = operation.step === 'RAIL_LOCK' ? current.classification === 'KEY_VACANT'
        : current.classification === 'KEY_OCCUPIED' && current.valueHash === sha256(previous);
      if (!eligible) throw new Error('PAPERRAIL_PRECHECK_REFUSED');
      privateReview = { action, value, previous, occupancyFingerprint: sha256(JSON.stringify(current)) };
      publicReview = { action, operationId: operation.id, namespace: session.deal.paperRail.namespace, key: session.deal.paperRail.key,
        conditionalWrite: operation.step === 'RAIL_LOCK' ? 'IF_ABSENT' : 'COMPARE_AND_SET', valueSha256: sha256(value),
        statement: 'Unsigned, world-writable, not a payment rail.' };
    }
    const fingerprint = sha256(JSON.stringify(publicReview)); privateReview.publicFingerprint = fingerprint;
    await writeFile(this.artifact(session, operation, `prepared-${action.toLowerCase()}`), `${JSON.stringify(privateReview)}\n`, { flag: 'wx', mode: 0o600 });
    return publicReview;
  }

  async execute({ session, operation, action, fingerprint }) {
    const prepared = JSON.parse(await readFile(this.artifact(session, operation, `prepared-${action.toLowerCase()}`), 'utf8'));
    const expected = Buffer.from(prepared.publicFingerprint, 'utf8'); const actual = Buffer.from(fingerprint, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('APPROVAL_BINDING_INVALID');
    if (action === 'SIGN') {
      const approved = await this.approveSign(prepared.request); if (!approved.ok) throw new Error('OPERATOR_CANCELLED');
      const identity = budgetIdentity({ purpose: 'PHASE3B_SIGN', operationClass: 'REAL_DETACHED_ROOM_SIGNATURE', subject: `${operation.id}-sign` });
      const budget = acquireOneShotAttempt(identity, { root: this.budgetRoot(session) });
      const response = await this.signBridge({ room: prepared.room, text: prepared.text, requestId: identity.subject,
        profile: operation.actor === 'Agent B' ? session.profiles.agentB.id : session.profiles.agentA.id,
        expectedSignerDid: prepared.expectedSignerDid, signBudget: budget });
      if (response.did !== prepared.expectedSignerDid || response.room !== prepared.room || response.text !== prepared.text
        || !verifyEd25519(response.did, canonicalMessage(response.room, response.nonce, response.text), response.signature)) throw new Error('SIGNER_RESPONSE_INVALID');
      const signed = { did: response.did, room: response.room, nonce: response.nonce, text: response.text, signature: response.signature };
      await writeFile(this.artifact(session, operation, 'signed'), `${JSON.stringify(signed)}\n`, { flag: 'wx', mode: 0o600 });
      return { classification: 'SIGNED', did: response.did, signedNonce: response.nonce, canonicalTextSha256: sha256(response.text) };
    }
    if (!await this.approveAction(action === 'PAPERRAIL_WRITE' ? 'PAPERRAIL WRITE' : action.replaceAll('_', ' '), fingerprint)) throw new Error('OPERATOR_CANCELLED');
    if (action.startsWith('PAPERRAIL_')) return this.writeRail(session, operation, prepared, action);
    return this.submit(session, operation, action, prepared);
  }

  async submit(session, operation, action, prepared) {
    const attempt = action === 'RECOVERY_SUBMIT' ? 'submit-attempt-2' : 'submit-attempt-1';
    const identity = budgetIdentity({ purpose: 'HUB_SUBMIT', operationClass: 'REAL_TECHNOCORE_ROOM_POST', subject: `${operation.id}-${attempt}` });
    acquireOneShotAttempt(identity, { root: this.budgetRoot(session) });
    let classification = 'SUBMISSION_UNCERTAIN'; let httpStatus = null; let diagnostic = null;
    try {
      const response = await this.transport(prepared.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: prepared.body, credentials: 'omit', redirect: 'error' });
      httpStatus = response.status; const text = await response.text();
      classification = response.status >= 200 && response.status < 300 ? 'ACK_RECEIVED' : response.status >= 400 && response.status < 500 ? 'REJECTED' : 'SUBMISSION_UNCERTAIN';
      if (classification !== 'ACK_RECEIVED') diagnostic = bounded(text);
    } catch (error) { diagnostic = bounded(error?.code ?? error?.name); }
    return { classification, httpStatus, diagnostic, postCalls: 1, automaticRetries: 0, attempt };
  }

  async writeRail(session, operation, prepared, action) {
    const current = await this.publicRead(session, operation); const currentFingerprint = sha256(JSON.stringify(current));
    if (currentFingerprint !== prepared.occupancyFingerprint) throw new Error('PAPERRAIL_APPROVAL_INVALIDATED');
    const attempt = action === 'PAPERRAIL_RECOVERY_WRITE' ? 'write-attempt-2' : 'write-attempt-1';
    const identity = budgetIdentity({ purpose: 'HUB_PAPERRAIL', operationClass: 'REAL_PAPERRAIL_NOTE_WRITE', subject: `${operation.id}-${attempt}` });
    acquireOneShotAttempt(identity, { root: this.budgetRoot(session) });
    const body = JSON.stringify(operation.step === 'RAIL_LOCK' ? { value: prepared.value, if_absent: true } : { value: prepared.value, if: prepared.previous });
    let response; try { response = await this.transport(`${session.venueOrigin}/kv/${encodeURIComponent(session.deal.paperRail.namespace)}/${encodeURIComponent(session.deal.paperRail.key)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'omit', redirect: 'error' }); }
    catch (error) { return { classification: 'SUBMISSION_UNCERTAIN', diagnostic: bounded(error?.code ?? error?.name), postCalls: 1, automaticRetries: 0, attempt }; }
    if (response.status < 200 || response.status >= 300) return { classification: response.status >= 400 && response.status < 500 ? 'REJECTED' : 'SUBMISSION_UNCERTAIN', httpStatus: response.status, postCalls: 1, automaticRetries: 0, attempt };
    const receipt = { classification: 'WRITE_RECEIPT', receiptSha256: sha256(body), expectedValueSha256: sha256(prepared.value), writtenAt: new Date().toISOString(), signed: false, worldWritable: true, valueMoved: false };
    await writeFile(this.artifact(session, operation, `rail-receipt-${attempt}`), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 }); return { ...receipt, attempt };
  }

  async observe({ session, operation }) {
    if (operation.kind === 'rail') {
      const expected = await this.railValue(session, operation); const current = await this.publicRead(session, operation); const exact = current.valueHash === sha256(expected);
      return { classification: exact ? 'OBSERVED_PUBLIC' : 'NOT_OBSERVED', expectedValueSha256: sha256(expected), observedValueSha256: current.valueHash,
        exactValueMatch: exact, recoveryAvailable: !exact && operation.attempts.some(item => item.result.classification === 'SUBMISSION_UNCERTAIN')
          && !operation.attempts.some(item => item.action === 'PAPERRAIL_RECOVERY_WRITE'), signed: false, worldWritable: true, valueMoved: false, observedAt: new Date().toISOString() };
    }
    const signed = JSON.parse(await readFile(this.artifact(session, operation, 'signed'), 'utf8'));
    const endpoints = [`${session.venueOrigin}/r/${encodeURIComponent(signed.room)}?format=json`, `${session.venueOrigin}/r/${encodeURIComponent(signed.room)}/export`];
    for (const endpoint of endpoints) {
      const response = await this.transport(endpoint, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error' });
      if (!response.ok) continue; const data = endpoint.endsWith('/export') ? (await response.text()).split(/\r?\n/).filter(Boolean).map(JSON.parse) : await response.json();
      const exact = exactPublicMatch(signed, data); if (exact.exactMatchCount === 1) return { classification: 'OBSERVED_PUBLIC', ...exact, canonicalTextSha256: sha256(signed.text), observationSource: endpoint };
    }
    return { classification: 'NOT_OBSERVED', exactMatchCount: 0, recoveryAvailable: operation.attempts.some(item => item.result.classification === 'SUBMISSION_UNCERTAIN')
      && !operation.attempts.some(item => item.action === 'RECOVERY_SUBMIT') };
  }

  exportPublic({ session }) {
    return { schema: 'tclk-blackbox/public-deal-capsule/v1', simulated: false, sessionId: session.id, manifestRoot: session.manifestRoot,
      venueOrigin: session.venueOrigin, complete: true, deal: session.deal, operatorModel: session.operatorModel,
      operations: session.operations.map(item => ({ operationId: item.id, step: item.step, state: 'COMPLETE', evidence: item.evidence })),
      limitations: ['ONE HUMAN OPERATOR / TWO DISTINCT CRYPTOGRAPHIC DIDS', 'PaperRail is unsigned, world-writable, moves no value and is not a payment rail.'] };
  }
}

export const V1_VENUE = DEFAULT_VENUE;
