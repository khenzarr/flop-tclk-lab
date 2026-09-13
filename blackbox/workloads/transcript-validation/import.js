const allowed = new Set(['https://tclk-blackbox.vercel.app', 'http://127.0.0.1:4173', 'http://localhost:4173']);
let token = null; let parentOrigin = null;
const status = document.getElementById('status');
if (window.opener) window.opener.postMessage({ type: 'BLACKBOX_W1_IMPORT_READY' }, '*');
window.addEventListener('message', event => {
  if (event.source !== window.opener || !allowed.has(event.origin) || event.data?.type !== 'BLACKBOX_W1_PAIR') return;
  if (typeof event.data.token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(event.data.token)) return;
  token = event.data.token; parentOrigin = event.origin; status.textContent = 'Paired. Choose a local export.';
});
document.getElementById('import-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!token || !parentOrigin) { status.textContent = 'Pair with BLACKBOX first.'; return; }
  const file = document.getElementById('transcript').files?.[0];
  if (!file || file.size > 12 * 1024 * 1024) { status.textContent = 'File exceeds the 12 MiB limit.'; return; }
  const room = document.getElementById('room').value.trim(); const generation = document.getElementById('generation').value.trim();
  try {
    status.textContent = 'Importing into the local connector…';
    const bytes = await file.arrayBuffer(); // This script is served by 127.0.0.1, never the production origin.
    const response = await fetch('/workloads/import', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson', 'X-Blackbox-Room': room, ...(generation ? { 'X-Room-Generation': generation } : {}) }, body: bytes, credentials: 'omit', redirect: 'error' });
    const descriptor = await response.json();
    if (!response.ok) { status.textContent = descriptor.code ?? descriptor.error ?? 'Local import failed.'; return; }
    const { importId, workloadId, sha256, byteLength, recordCount, generationStatus, roomDisplay } = descriptor;
    window.opener.postMessage({ type: 'BLACKBOX_W1_IMPORTED', descriptor: { importId, workloadId, sha256, byteLength, recordCount, generationStatus, roomDisplay } }, parentOrigin);
    status.textContent = 'Imported locally. Return to BLACKBOX to validate.';
  } catch { status.textContent = 'Local import could not complete.'; }
});
