import { clearPairing, connectionStatus, connectorRequest, importPairing } from './connector-client.js';

const byId = id => document.getElementById(id);
const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const page = document.body.dataset.page;
let connection;

function message(text, tone = '') { const node = byId('page-message'); if (!node) return; node.textContent = text; node.dataset.tone = tone; node.hidden = false; }
function short(value, start = 13, end = 8) { return value.length > start + end ? `${value.slice(0, start)}…${value.slice(-end)}` : value; }

function renderConnection(status) {
  connection = status;
  document.querySelectorAll('[data-connection]').forEach(node => {
    node.dataset.state = status.state;
    node.textContent = status.state === 'CONNECTED' ? `Connector ready · ${status.mode}` : status.state === 'CONNECTOR_UNAVAILABLE' ? 'Connector unavailable' : 'Not connected';
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
    byId('open-record').hidden = !deal.finalized; byId('export-record').hidden = !deal.finalized;
    if (deal.finalized) { byId('export-record').href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(deal.publicCapsule, null, 2))}`; byId('export-record').download = `${deal.id}-public-record.json`; }
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
      const item = make('a', 'record-row'); item.href = `/deal/live/${deal.id}`;
      item.append(make('strong', '', deal.id), make('span', '', `${deal.deal.amount} ${deal.deal.asset}`), make('em', '', deal.finalized ? 'COMPLETE' : 'IN PROGRESS')); list.append(item);
    }
    byId('empty-records').hidden = deals.length > 0;
  } catch (error) { message(error.message, 'error'); }
}

async function loadProfiles() {
  if (connection.state !== 'CONNECTED') return;
  try {
    const result = await connectorRequest('/profiles');
    for (const [selectId, selected] of [['profile-a', 0], ['profile-b', 1]]) {
      const select = byId(selectId); select.replaceChildren();
      result.profiles.forEach((profile, index) => { const option = make('option', '', `${profile.label} · ${short(profile.did, 15, 8)}`); option.value = profile.id; option.selected = index === selected; select.append(option); });
    }
  } catch (error) { message(error.message, 'error'); }
}

async function routeLoad() {
  if (page === 'new') await loadProfiles();
  if (page === 'live') await renderLive();
  if (page === 'records') await renderRecords();
}

async function start() {
  bindPairing(); renderConnection(await connectionStatus());
  const form = byId('new-deal-form');
  if (form) form.addEventListener('submit', async event => {
    event.preventDefault(); if (connection.state !== 'CONNECTED') return message('Connect the local agent first.', 'error');
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const deal = await connectorRequest('/deals', { method: 'POST', body: { amount: byId('amount').value, asset: byId('asset').value.toUpperCase(), profileA: byId('profile-a').value, profileB: byId('profile-b').value } });
      location.assign(`/deal/live/${deal.id}`);
    } catch (error) { message(error.message, 'error'); button.disabled = false; }
  });
  const finalize = byId('finalize-deal');
  if (finalize) finalize.addEventListener('click', async () => { try { await connectorRequest(`/deals/${byId('deal-id').textContent}/finalize`, { method: 'POST', body: {} }); await renderLive(); } catch (error) { message(error.message, 'error'); } });
  await routeLoad();
}

start();
