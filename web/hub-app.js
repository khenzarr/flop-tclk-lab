import { cachePublicRecord, clearPairing, connectionStatus, connectorRequest, importPairing, publicRecordRoute } from './connector-client.js';

const byId = id => document.getElementById(id);
const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const page = document.body.dataset.page;
let connection;
let identityActionId;

function message(text, tone = '') { const node = byId('page-message'); if (!node) return; node.textContent = text; node.dataset.tone = tone; node.hidden = false; }
function short(value, start = 13, end = 8) { return value.length > start + end ? `${value.slice(0, start)}…${value.slice(-end)}` : value; }

function renderConnection(status) {
  connection = status;
  document.querySelectorAll('[data-connection]').forEach(node => {
    node.dataset.state = status.state;
    node.textContent = status.state === 'CONNECTED' ? `Connected locally · ${status.mode}` : status.state === 'PAIRING_REQUIRED' ? 'Connector found · pairing required' : status.state === 'CONNECTOR_UNAVAILABLE' ? 'Pairing invalid · reconnect' : 'Connector offline';
  });
  document.querySelectorAll('[data-requires-connection]').forEach(node => { node.disabled = status.state !== 'CONNECTED'; });
  const banner = byId('simulation-banner');
  if (banner) banner.hidden = status.mode !== 'SIMULATED / LOCAL TEST';
}

function bindPairing() {
  document.querySelectorAll('[data-pairing-input]').forEach(input => input.addEventListener('change', async () => {
    try { await importPairing(input.files[0]); renderConnection(await connectionStatus()); message('Local connector verified. Browser custody remains public-safe.', 'success'); await routeLoad(); }
    catch (error) { renderConnection({ state: 'NOT_CONNECTED' }); message(error.message, 'error'); }
    input.value = '';
  }));
  document.querySelectorAll('[data-disconnect]').forEach(button => button.addEventListener('click', () => { clearPairing(); renderConnection({ state: 'NOT_CONNECTED' }); location.reload(); }));
}

function operationAction(operation) {
  if (['READY', 'SIGNED', 'NOT_OBSERVED'].includes(operation.state)) return { kind: 'approval', label: operation.state === 'SIGNED' ? 'Review submit' : operation.state === 'NOT_OBSERVED' ? operation.kind === 'rail' ? 'Review rail recovery write' : 'Review recovery submit' : operation.kind === 'rail' ? 'Review rail write' : 'Review local signature' };
  if (operation.state === 'AWAITING_LOCAL_APPROVAL') return { kind: 'execute', label: 'Open terminal approval' };
  if (['ACK_RECEIVED', 'SUBMISSION_UNCERTAIN', 'WRITE_RECEIPT'].includes(operation.state)) return { kind: 'refresh', label: 'Refresh public evidence' };
  return null;
}

async function renderLive() {
  if (connection.state !== 'CONNECTED') return;
  const id = location.pathname.match(/^\/deal\/live\/(bbx-[0-9a-f]{16})\/?$/)?.[1];
  if (!id) return message('Deal link is invalid.', 'error');
  try {
    const deal = await connectorRequest(`/deals/${id}`);
    byId('deal-id').textContent = deal.id; byId('deal-summary').textContent = `${deal.deal.amount} ${deal.deal.asset} · ${short(deal.deal.contractId)}`;
    byId('deal-mode').textContent = deal.label;
    const list = byId('operation-list'); list.replaceChildren();
    for (const operation of deal.operations) {
      const card = make('article', `operation-card state-${operation.state.toLowerCase()}`);
      const head = make('div', 'operation-head'); head.append(make('span', 'operation-index', String(operation.ordinal).padStart(2, '0')), make('strong', '', operation.step.replace('_', ' ')), make('em', '', operation.state.replaceAll('_', ' ')));
      const copy = make('p', 'operation-copy', operation.state === 'BLOCKED' ? 'Waiting for predecessor evidence.' : operation.state === 'SIGNED' ? 'Signed locally. Nothing has been submitted.' : operation.state === 'ACK_RECEIVED' ? 'Acknowledged, but not complete until exact public observation.' : operation.state === 'SUBMISSION_UNCERTAIN' ? 'Submission uncertain. No automatic retry; observe first.' : operation.state === 'WRITE_RECEIPT' ? 'Receipt stored. Exact public rail value still required.' : operation.state === 'VERIFIED' || operation.state === 'COMPLETE' ? 'Required evidence verified.' : 'Ready for operator review.');
      card.append(head, copy);
      const action = operationAction(operation);
      if (action && !(operation.state === 'NOT_OBSERVED' && !operation.recoveryAvailable)) {
        const label = action.kind === 'execute' && deal.simulated ? 'Run simulated approval' : action.label;
        const button = make('button', 'button button-primary operation-action', label); button.type = 'button';
        button.addEventListener('click', () => runOperation(deal, operation, action, button)); card.append(button);
      }
      list.append(card);
    }
    const finalize = byId('finalize-deal'); finalize.hidden = deal.finalized; finalize.disabled = !deal.operations.every(item => item.state === 'VERIFIED');
    for (const id of ['open-record', 'open-evidence', 'export-record', 'completion-summary', 'public-evidence']) byId(id).hidden = !deal.finalized;
    if (deal.finalized) {
      const json = JSON.stringify(deal.publicCapsule, null, 2); byId('public-evidence-json').textContent = json;
      cachePublicRecord(deal.publicCapsule);
      const recordRoute = publicRecordRoute(deal.id); const openRecord = byId('open-record'); openRecord.href = recordRoute;
      openRecord.onclick = event => { event.preventDefault(); location.assign(recordRoute); };
      byId('export-record').href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`; byId('export-record').download = `${deal.id}-public-record.json`;
      message('Flight record finalized. No local approval pending.', 'success');
    }
  } catch (error) { message(error.message, 'error'); }
}

async function runOperation(deal, operation, action, button) {
  button.disabled = true;
  try {
    if (action.kind === 'approval') {
      await connectorRequest(`/deals/${deal.id}/actions/${operation.id}/prepare`, { method: 'POST', body: {} });
      message(deal.simulated ? 'Simulated action frozen. Continue to exercise the labeled test transition.' : 'Action frozen. Continue to the local terminal for explicit approval.', 'warn');
    } else if (action.kind === 'execute') {
      message(deal.simulated ? 'Running a simulated transition. No signature, nonce, POST, or rail write occurs.' : 'Waiting for explicit approval in the local terminal. The browser cannot approve or sign.', 'warn');
      await connectorRequest(`/deals/${deal.id}/actions/${operation.id}/execute`, { method: 'POST', body: {} });
    } else await connectorRequest(`/deals/${deal.id}/refresh`, { method: 'POST', body: { operationId: operation.id } });
    await renderLive();
  } catch (error) { message(error.message, 'error'); button.disabled = false; }
}

async function renderRecords() {
  if (connection.state !== 'CONNECTED') return;
  try {
    const { deals } = await connectorRequest('/deals'); const list = byId('record-list');
    for (const deal of deals) {
      const item = make('a', 'record-row'); item.href = deal.finalized ? publicRecordRoute(deal.id) : `/deal/live/${deal.id}`;
      item.append(make('strong', '', deal.id), make('span', '', `${deal.deal.amount} ${deal.deal.asset}`), make('em', '', deal.finalized ? 'COMPLETE' : 'IN PROGRESS')); list.append(item);
    }
    byId('empty-records').hidden = deals.length > 0;
  } catch (error) { message(error.message, 'error'); }
}

async function loadProfiles() {
  if (connection.state !== 'CONNECTED') return;
  try {
    const result = await connectorRequest('/profiles');
    const primary = result.identity?.identities?.find(identity => identity.isPrimary);
    const primaryCard = byId('deal-primary-identity');
    if (primaryCard) {
      primaryCard.querySelector('strong').textContent = primary ? short(primary.did, 20, 10) : 'Identity setup required';
      primaryCard.dataset.ready = primary?.status === 'IDENTITY_READY' ? 'true' : 'false';
    }
    const primaryIndex = Math.max(0, result.profiles.findIndex(profile => profile.did === result.identity?.primaryDid));
    const counterpartyIndex = result.profiles.findIndex((profile, index) => index !== primaryIndex && profile.did !== result.identity?.primaryDid);
    for (const [selectId, selected] of [['profile-a', primaryIndex], ['profile-b', counterpartyIndex < 0 ? 0 : counterpartyIndex]]) {
      const select = byId(selectId); select.replaceChildren();
      result.profiles.forEach((profile, index) => { const option = make('option', '', `${profile.label} · ${short(profile.did, 15, 8)}`); option.value = profile.id; option.selected = index === selected; select.append(option); });
    }
  } catch (error) { message(error.message, 'error'); }
}

const statusCopy = Object.freeze({
  NO_IDENTITY: ['No agent identity found', 'Create one locally or link a compatible identity already on this computer.'],
  MULTIPLE_IDENTITIES_FOUND: ['Choose your primary identity', 'BLACKBOX found more than one compatible DID and will not choose or create another silently.'],
  IDENTITY_READY: ['Your identity is ready', 'BLACKBOX will reuse this DID. Signing material remains protected by the local provider.'],
  IDENTITY_LOCKED: ['Your identity is locked', 'The identity exists, but the local signer must be unlocked before it can sign.'],
  SIGNER_UNAVAILABLE: ['Signer unavailable', 'The public identity exists, but its compatible local signer is not available.'],
  IDENTITY_DISCOVERED: ['Existing identity found', 'Review the detected public identity and choose it as primary.'],
});

function identityCard(identity, selectable) {
  const card = make('article', `identity-card ${identity.isPrimary ? 'is-primary' : ''}`);
  const top = make('div', 'identity-card-top'); top.append(make('span', '', identity.isPrimary ? 'PRIMARY IDENTITY' : 'COMPATIBLE IDENTITY'), make('em', '', identity.status.replaceAll('_', ' ')));
  const did = make('code', 'identity-did', identity.did);
  const facts = make('dl', 'identity-facts');
  for (const [label, value] of [['Fingerprint', identity.fingerprint], ['Provider', identity.provider.replaceAll('_', ' ')], ['Custody', identity.custodyMode], ['Signer', identity.signerAvailable ? 'READY' : 'UNAVAILABLE']]) {
    const row = make('div'); row.append(make('dt', '', label), make('dd', '', label === 'Fingerprint' ? short(value, 14, 10) : value)); facts.append(row);
  }
  const actions = make('div', 'identity-actions'); const copy = make('button', 'button button-quiet', 'Copy DID'); copy.type = 'button';
  copy.addEventListener('click', async () => { await navigator.clipboard.writeText(identity.did); message('Public DID copied.', 'success'); }); actions.append(copy);
  if (selectable && !identity.isPrimary) { const choose = make('button', 'button button-primary', 'Use as primary'); choose.type = 'button'; choose.addEventListener('click', async () => { await connectorRequest('/identity/primary', { method: 'POST', body: { did: identity.did } }); await renderIdentity(); }); actions.append(choose); }
  card.append(top, did, facts, actions); return card;
}

async function renderIdentity() {
  if (connection.state !== 'CONNECTED') return;
  try {
    const state = await connectorRequest('/identity'); const copy = statusCopy[state.status] ?? statusCopy.IDENTITY_DISCOVERED;
    byId('identity-heading').textContent = copy[0]; byId('identity-status').textContent = state.status.replaceAll('_', ' ');
    const list = byId('identity-list'); list.replaceChildren();
    if (state.identityCount === 0) list.append(make('p', 'identity-empty-copy', copy[1]));
    else for (const identity of state.identities) list.append(identityCard(identity, state.identityCount > 1));
    byId('identity-empty-actions').hidden = state.identityCount !== 0;
  } catch (error) { message(error.message, 'error'); }
}

async function renderHubIdentity() {
  if (connection.state !== 'CONNECTED') return;
  try {
    const state = await connectorRequest('/identity'); const primary = state.identities.find(identity => identity.isPrimary);
    byId('hub-identity-title').textContent = primary ? short(primary.did, 20, 10) : statusCopy[state.status]?.[0] ?? 'Identity setup required';
    byId('hub-identity-copy').textContent = primary ? `${primary.provider.replaceAll('_', ' ')} · ${primary.custodyMode} custody` : statusCopy[state.status]?.[1] ?? 'Open Identity Center to continue.';
    const detail = byId('hub-identity-detail'); detail.querySelector('strong').textContent = state.status.replaceAll('_', ' '); detail.dataset.ready = state.status === 'IDENTITY_READY' ? 'true' : 'false';
  } catch (error) { message(error.message, 'error'); }
}

async function renderTechnocore() {
  if (connection.state !== 'CONNECTED') return;
  try {
    const activity = await connectorRequest('/identity/activity'); byId('venue-origin').textContent = activity.venueOrigin;
    byId('signed-activity-count').textContent = String(activity.signedActivity.length); byId('room-count').textContent = String(activity.rooms.length);
    const list = byId('activity-list'); list.replaceChildren();
    if (!activity.recentVerifiedRecords.length) list.append(make('div', 'empty-state', 'No completed BLACKBOX records are linked to the discovered identity yet.'));
    for (const record of activity.recentVerifiedRecords) {
      const item = make('a', 'activity-row'); item.href = publicRecordRoute(record.sessionId);
      item.append(make('strong', '', record.sessionId), make('code', '', short(record.room, 18, 10)), make('span', '', 'VERIFIED RECORD')); list.append(item);
    }
    const primary = activity.identities.find(identity => identity.isPrimary); if (primary) byId('verify-did').value = primary.did;
  } catch (error) { message(error.message, 'error'); }
}

async function routeLoad() {
  if (page === 'hub') await renderHubIdentity();
  if (page === 'identity') await renderIdentity();
  if (page === 'technocore') await renderTechnocore();
  if (page === 'new') await loadProfiles();
  if (page === 'live') await renderLive();
  if (page === 'records') await renderRecords();
}

async function start() {
  bindPairing(); const status = await connectionStatus(); renderConnection(status);
  if (status.state === 'CONNECTOR_OFFLINE') message("BLACKBOX couldn't reach your local connector. Make sure `pnpm connector` is running and allow local-network access in your browser if prompted.", 'error');
  const form = byId('new-deal-form');
  if (form) form.addEventListener('submit', async event => {
    event.preventDefault(); if (connection.state !== 'CONNECTED') return message('Connect the local agent first.', 'error');
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const deal = await connectorRequest('/deals', { method: 'POST', body: { amount: byId('amount').value, asset: byId('asset').value.toUpperCase(), profileA: byId('profile-a').value, profileB: byId('profile-b').value } });
      location.assign(`/deal/live/${deal.id}`);
    } catch (error) { message(error.message, 'error'); button.disabled = false; }
  });
  const createIdentity = byId('create-identity');
  if (createIdentity) createIdentity.addEventListener('click', async () => {
    try { const action = await connectorRequest('/identity/create/prepare', { method: 'POST', body: {} }); identityActionId = action.actionId; byId('creation-approval').hidden = false; message('Identity creation prepared. Nothing has been created yet.', 'warn'); }
    catch (error) { message(error.message, 'error'); }
  });
  const executeIdentity = byId('execute-identity');
  if (executeIdentity) executeIdentity.addEventListener('click', async () => {
    executeIdentity.disabled = true;
    try { message('Continue in the local terminal. Passphrase entry stays outside the browser.', 'warn'); await connectorRequest('/identity/create/execute', { method: 'POST', body: { actionId: identityActionId } }); byId('creation-approval').hidden = true; await renderIdentity(); message('Your identity is ready and will be reused.', 'success'); }
    catch (error) { message(error.message, 'error'); executeIdentity.disabled = false; }
  });
  const linkIdentity = byId('link-identity');
  if (linkIdentity) linkIdentity.addEventListener('click', async () => { try { await connectorRequest('/identity/link', { method: 'POST', body: {} }); await renderIdentity(); message('Known local identity locations checked. No private file was uploaded.', 'success'); } catch (error) { message(error.message, 'error'); } });
  const verifyForm = byId('verify-form');
  if (verifyForm) verifyForm.addEventListener('submit', async event => {
    event.preventDefault(); const output = byId('verify-result');
    try { const result = await connectorRequest('/identity/verify', { method: 'POST', body: { did: byId('verify-did').value.trim(), room: byId('verify-room').value.trim(), nonce: byId('verify-nonce').value.trim(), message: byId('verify-message').value, signature: byId('verify-signature').value.trim() } }); output.textContent = result.valid ? 'VALID SIGNATURE · KEY CONTROL VERIFIED' : 'SIGNATURE NOT VALID'; output.dataset.valid = result.valid ? 'true' : 'false'; }
    catch (error) { output.textContent = error.message; output.dataset.valid = 'false'; }
  });
  const finalize = byId('finalize-deal');
  if (finalize) finalize.addEventListener('click', async () => { try { await connectorRequest(`/deals/${byId('deal-id').textContent}/finalize`, { method: 'POST', body: {} }); await renderLive(); } catch (error) { message(error.message, 'error'); } });
  await routeLoad();
}

start();
