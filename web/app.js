import referenceCapsule from './capsule.js';
import { cachedPublicRecord, publicRecordRequest } from './connector-client.js';
import { createFlightRecorderModel, createHubFlightRecorderModel } from './public-capsule-adapter.js';

const byId = id => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const dynamicSessionId = location.pathname.match(/^\/deal\/record\/(bbx-[0-9a-f]{16})\/?$/)?.[1] ?? null;
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
let capsule = referenceCapsule; let model; let loadError = null;
try {
  if (dynamicSessionId) {
    capsule = cachedPublicRecord(dynamicSessionId) ?? (await publicRecordRequest(dynamicSessionId)).record;
    model = createHubFlightRecorderModel(capsule, await sha256(JSON.stringify(capsule)));
  } else model = createFlightRecorderModel(capsule);
} catch (error) { loadError = error; }
const shorten = (value, start = 12, end = 8) => `${value.slice(0, start)}…${value.slice(-end)}`;
const timestamp = value => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let selectedIndex = 0;
let replayTimer;

function configureSource() {
  if (!dynamicSessionId) return;
  document.title = `${dynamicSessionId} · TCLK BLACKBOX Flight Record`;
  const eyebrow = document.querySelector('.eyebrow'); eyebrow.replaceChildren(make('span', 'rec-dot'), document.createTextNode(' Hub-created completed record · local playback'));
  byId('hero-title').textContent = 'The flight record for this Hub deal.';
  document.querySelector('.hero-lede').textContent = 'This read-only playback comes from the completed public-safe record held by your local BLACKBOX connector.';
  byId('record-label').textContent = `BBX / ${dynamicSessionId.toUpperCase()}`;
  byId('footer-record-id').textContent = dynamicSessionId;
  byId('reference-recovery').hidden = true;
  document.querySelector('.heading-note').textContent = 'Public-safe identifiers from this Hub-created completed record.';
}

function renderUnavailable() {
  document.title = 'Local flight record unavailable · TCLK BLACKBOX';
  document.querySelector('.eyebrow').textContent = 'Local completed record unavailable';
  byId('hero-title').textContent = 'Reconnect the local BLACKBOX connector.';
  document.querySelector('.hero-lede').textContent = 'This Hub-created record is read-only and needs the local connector that holds its public-safe completed capsule. No pairing secret or signer access is required.';
  document.querySelector('.recorder-preview').hidden = true;
  document.querySelectorAll('.hero-actions, .narrative, main > section:not(.hero)').forEach(node => { node.hidden = true; });
  console.warn(`Flight record unavailable: ${loadError?.message ?? 'UNKNOWN'}`);
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message; toast.classList.add('is-visible');
  window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); showToast(message); }
  catch { showToast('Copy unavailable — select the value manually'); }
}

function renderPreview() {
  const target = byId('preview-events');
  for (const [index, step] of model.steps.entries()) {
    const row = make('div', 'preview-row');
    row.append(make('span', '', String(index + 1).padStart(2, '0')), make('strong', '', step.label), make('i'), make('b', '', 'Verified'));
    target.append(row);
  }
}

function selectStep(index, { focus = false } = {}) {
  selectedIndex = index;
  const step = model.steps[index];
  document.querySelectorAll('.timeline-step').forEach((button, buttonIndex) => {
    const active = buttonIndex === index;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'step' : 'false');
    if (active && focus) button.focus();
  });
  byId('inspector-index').textContent = `${String(index + 1).padStart(2, '0')} / 06 · ${step.code.replace('_', ' ')}`;
  byId('inspector-actor').textContent = step.actor;
  byId('inspector-title').textContent = step.action.charAt(0).toUpperCase() + step.action.slice(1);
  byId('inspector-explain').textContent = step.statusDetail;
  const proof = byId('rail-proof');
  proof.replaceChildren(); proof.hidden = step.kind !== 'rail';
  if (step.kind === 'rail') {
    for (const [label, detail] of [['Receipt', 'written'], ['Public read', 'observed'], ['Exact value', 'matched'], ['Evidence', 'verified']]) {
      const item = make('div'); item.append(make('strong', '', label), make('span', '', detail)); proof.append(item);
    }
  }
  const fields = byId('evidence-fields'); fields.replaceChildren();
  for (const [label, value] of step.fields) {
    const row = make('div', 'evidence-row'); const dt = make('dt', '', label); const dd = make('dd');
    const display = value.startsWith?.('http') ? shorten(value, 28, 16) : value.length > 34 ? shorten(value) : value;
    dd.textContent = display; dd.title = value;
    if (value.length > 24 && !value.startsWith('http')) {
      const button = make('button', 'copy-mini', 'Copy'); button.type = 'button';
      button.setAttribute('aria-label', `Copy ${label}`); button.addEventListener('click', () => copyText(value, `${label} copied`)); dd.append(button);
    }
    row.append(dt, dd); fields.append(row);
  }
}

function renderTimeline() {
  const timeline = byId('timeline');
  for (const [index, step] of model.steps.entries()) {
    const item = make('div', 'timeline-item'); item.setAttribute('role', 'listitem');
    const button = make('button', 'timeline-step'); button.type = 'button';
    button.setAttribute('aria-label', `${index + 1} of 6: ${step.label}. ${step.status}`);
    const top = make('span', 'step-top'); top.append(make('span', 'step-number', String(index + 1).padStart(2, '0')), make('span', 'step-time', `${timestamp(step.timestamp)} UTC`));
    const center = make('span', 'step-center'); center.append(make('i', 'step-node'), make('span', 'step-line'));
    const bottom = make('span', 'step-bottom'); bottom.append(make('strong', '', step.label), make('small', '', step.actor), make('em', '', `✓ ${step.status}`));
    button.append(top, center, bottom);
    button.addEventListener('click', () => selectStep(index));
    button.addEventListener('keydown', event => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') selectStep(0, { focus: true });
      else if (event.key === 'End') selectStep(model.steps.length - 1, { focus: true });
      else selectStep((index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + model.steps.length) % model.steps.length, { focus: true });
    });
    item.append(button); timeline.append(item);
  }
  selectStep(0);
}

function renderDeal() {
  const rows = [
    ['Lineage', model.deal.lineageId], ['Contract ID', model.deal.contractId], ['Venue', model.deal.venueHost],
    ['Manifest root', model.deal.manifestRoot], ['Deal room', model.deal.dealRoom], ['Trust model', 'One operator · two DIDs'],
  ];
  const list = byId('deal-fields');
  for (const [label, value] of rows) {
    const row = make('div'); row.append(make('dt', '', label)); const dd = make('dd', '', value.length > 32 ? shorten(value, 18, 12) : value); dd.title = value;
    if (value.length > 28) { const copy = make('button', 'copy-mini', 'Copy'); copy.type = 'button'; copy.addEventListener('click', () => copyText(value, `${label} copied`)); dd.append(copy); }
    row.append(dd); list.append(row);
  }
  byId('did-a').textContent = shorten(model.trust.didA, 10, 7); byId('did-a').title = model.trust.didA;
  byId('did-b').textContent = shorten(model.trust.didB, 10, 7); byId('did-b').title = model.trust.didB;
}

function replay() {
  window.clearInterval(replayTimer);
  if (reducedMotion.matches) { selectStep(model.steps.length - 1); showToast('Record moved to verified completion'); return; }
  let index = 0; selectStep(index);
  const button = byId('replay-button'); button.classList.add('is-playing'); button.disabled = true;
  replayTimer = window.setInterval(() => {
    index += 1;
    if (index >= model.steps.length) {
      window.clearInterval(replayTimer); button.classList.remove('is-playing'); button.disabled = false; showToast('Flight record complete'); return;
    }
    selectStep(index);
  }, 620);
}

function wireEvidenceDialog() {
  const dialog = byId('evidence-dialog'); const raw = `${JSON.stringify(capsule, null, 2)}\n`;
  byId('raw-json').textContent = raw; byId('capsule-sha').textContent = model.capsuleSha256; byId('dialog-sha').textContent = shorten(model.capsuleSha256, 16, 12);
  document.querySelectorAll('[data-open-evidence]').forEach(button => button.addEventListener('click', () => dialog.showModal()));
  document.querySelector('[data-close-evidence]').addEventListener('click', () => dialog.close());
  document.querySelector('[data-copy-json]').addEventListener('click', () => copyText(raw, 'Evidence JSON copied'));
  document.querySelector('[data-copy-sha]').addEventListener('click', () => copyText(model.capsuleSha256, 'Capsule hash copied'));
  if (dynamicSessionId) {
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    document.querySelectorAll('[data-download-evidence]').forEach(link => { link.href = url; link.download = `${dynamicSessionId}-public-record.json`; });
  }
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}

function wireMotion() {
  if (reducedMotion.matches || !('IntersectionObserver' in window)) { document.querySelectorAll('.reveal').forEach(node => node.classList.add('is-visible')); return; }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
  }, { threshold: 0.14 });
  document.querySelectorAll('.reveal').forEach(node => observer.observe(node));
}

if (loadError) renderUnavailable();
else {
  configureSource(); renderPreview(); renderTimeline(); renderDeal(); wireEvidenceDialog(); wireMotion();
  byId('console-root').textContent = shorten(model.deal.manifestRoot, 8, 6);
  byId('complete-summary').textContent = `${model.summary.totalSteps} actions recorded · ${model.summary.verifiedSteps} verified · ${model.summary.unresolvedSteps} unresolved`;
  byId('replay-button').addEventListener('click', replay);
}
