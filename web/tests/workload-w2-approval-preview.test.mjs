import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sourceUrl = new URL('../workload-record.js', import.meta.url);
const recordId = `w1-${'a'.repeat(32)}`;
const workloadId = 'b'.repeat(64);
const evidenceSha = `sha256:${'c'.repeat(64)}`;
const signedTextSha = `sha256:${'d'.repeat(64)}`;
const operationId = `w2op1-${'e'.repeat(64)}`;
const approvalHash = `sha256:${'f'.repeat(64)}`;
const did = `did:key:z6Mk${'1'.repeat(44)}`;
const venue = 'https://technocore.chat';
const room = 'w2-human-acceptance';
const nonce = '9007199254740993';
const issuedAt = '2026-09-14T10:00:00.000Z';
const expiresAt = '2026-09-14T10:15:00.000Z';
const signedText = `blackbox-w2 {"schema":"blackbox/validation-result-assertion/v1","verdict":"VALID","workloadId":"${workloadId}"}`;

function node(tagName = 'div', textContent = '') {
  return { tagName: tagName.toUpperCase(), textContent, className: '', children: [], listeners: {}, hidden: false, disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute(name, value) { this[name] = value; }, remove() {} };
}
const flatten = item => [item.textContent, ...item.children.flatMap(child => flatten(child))].filter(Boolean).join(' ');
const find = (item, predicate) => predicate(item) ? item : item.children.map(child => find(child, predicate)).find(Boolean);

function operation() {
  const candidate = { schema: 'blackbox/w2-sign-approval/v1', operationId, evidenceArtifactSha256: evidenceSha, targetVenueOrigin: venue,
    targetRoom: room, signerDid: did, nonce, signedText, signedTextSha256: signedTextSha, approvalIssuedAt: issuedAt, approvalExpiresAt: expiresAt };
  return { state: 'APPROVAL_PENDING', operationId, evidenceArtifactSha256: evidenceSha, venueOrigin: venue, room, signerDid: did, nonce,
    signedText, signedTextSha256: signedTextSha, assertion: { schema: 'blackbox/validation-result-assertion/v1', verdict: 'VALID', workloadId },
    signApproval: { candidate, approvalHash } };
}

async function renderPreview({ preparedOperation = operation(), actionOperation = null } = {}) {
  const source = (await readFile(sourceUrl, 'utf8')).replace(/^import \{ connectorRequest \} from '\.\/connector-client\.js';\r?\n/, '');
  const created = []; const main = node('main'); const footerText = node('p'); const footerId = node('span');
  const document = { title: '', createElement: tag => { const item = node(tag); created.push(item); return item; },
    getElementById: name => name === 'footer-record-id' ? footerId : null,
    querySelector: selector => ({ main, 'footer .section-shell > p': footerText, dialog: node('dialog') })[selector] ?? null };
  const calls = []; const connectorRequest = async (path, options) => { calls.push({ path, options });
    if (path.endsWith('/record')) return { publicationEnabled: true, record: { executionType: 'LOCAL_VALIDATION', transportStates: [],
      artifact: { schema: 'blackbox/workload-evidence/v1', workloadType: 'technocore-transcript-validation/v1', verdict: 'VALID', workloadId,
        coverage: { windowStatus: 'BOUNDED', generation: { status: 'KNOWN' } }, input: { sha256: '0'.repeat(64), byteLength: 1 },
        summary: { signedVerified: 1, unsignedContext: 0 }, verifier: { id: 'technocore-transcript-validation/v1', implementationDigest: 'sha256:test' }, checks: [], limitations: [] } } };
    if (path.endsWith('/publication/prepare')) return preparedOperation;
    if (path.endsWith('/sign') && actionOperation) return actionOperation;
    throw new Error(`UNEXPECTED_CALL:${path}`); };
  let now = Date.parse(issuedAt); let timer = null; const window = { setTimeout(callback, delay) { timer = { callback, delay }; return 1; }, clearTimeout() { timer = null; } };
  const DateFacade = { now: () => now, parse: Date.parse };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('document', 'location', 'connectorRequest', 'URL', 'Blob', 'window', 'Date', 'navigator', source)(document,
    { pathname: `/deal/record/${recordId}` }, connectorRequest, { createObjectURL: () => 'blob:test' }, Blob, window, DateFacade, { clipboard: { writeText: async () => {} } });
  const inputs = created.filter(item => item.tagName === 'INPUT'); inputs[0].value = venue; inputs[1].value = room; inputs[2].value = did;
  const prepare = find(main, item => item.tagName === 'BUTTON' && item.textContent === 'Prepare exact publication'); await prepare.listeners.click();
  return { main, calls, timer: () => timer, advance(value) { now = value; } };
}

test('W2 approval preview exposes every exact frozen approval field before signing', async () => {
  const view = await renderPreview(); const text = flatten(view.main);
  for (const expected of ['You are approving exactly this publication.', 'Result', 'VALID', 'W1 workload ID', workloadId,
    'Evidence artifact SHA-256', evidenceSha, 'Venue', venue, 'Room', room, 'Signer DID', did, 'Nonce', nonce,
    'Schema / version', 'blackbox/validation-result-assertion/v1', 'Signed text SHA-256', signedTextSha, signedText,
    'Operation ID', operationId, 'Approval hash', approvalHash, 'Approval issued at', issuedAt, 'Approval expires at', expiresAt]) assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(view.calls.length, 2); assert.equal(view.calls[1].options.body.room, room);
  assert.ok(find(view.main, item => item.className.includes('publication-canonical-text')));
  assert.ok(find(view.main, item => item.textContent === 'Copy'));
});

test('W2 preview preserves lossless nonce and fixed expiry across rerender, then disables signing when that approval expires', async () => {
  const stable = operation(); const view = await renderPreview({ preparedOperation: stable, actionOperation: structuredClone(stable) });
  const before = flatten(view.main); let timer = view.timer();
  assert.match(before, new RegExp(nonce)); assert.match(before, new RegExp(expiresAt.replaceAll('.', '\\.'))); assert.ok(timer.delay > 0);
  const sign = find(view.main, item => item.textContent === 'Approve exact publication · sign locally'); await sign.listeners.click();
  assert.equal(view.calls[2].path, `/workloads/${recordId}/publication/${operationId}/sign`);
  assert.match(flatten(view.main), new RegExp(expiresAt.replaceAll('.', '\\.')));
  timer = view.timer();
  view.advance(Date.parse(expiresAt) + 1); timer.callback();
  const after = flatten(view.main);
  assert.match(after, /APPROVAL PENDING · EXPIRED/); assert.match(after, new RegExp(expiresAt.replaceAll('.', '\\.'))); assert.equal(sign.disabled, true);
});

test('W2 preview invalidates the sign control when a security-critical approval binding differs', async () => {
  const mismatched = operation(); mismatched.room = 'changed-after-approval';
  const view = await renderPreview({ preparedOperation: mismatched }); const text = flatten(view.main);
  const sign = find(view.main, item => item.textContent === 'Approve exact publication · sign locally');
  assert.match(text, /APPROVAL BINDING INVALID/); assert.equal(sign.disabled, true);
  assert.match(text, new RegExp(room)); assert.doesNotMatch(text, /changed-after-approval/);
});
