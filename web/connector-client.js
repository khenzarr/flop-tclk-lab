const STORAGE_KEY = 'tclk-blackbox/pairing/v1';
const PAIRING_SCHEMA = 'tclk-blackbox/connector-pairing/v1';

function validate(record) {
  if (!record || record.schema !== PAIRING_SCHEMA) throw new Error('PAIRING_FILE_INVALID');
  const url = new URL(record.connectorUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '8787' || url.pathname !== '/') throw new Error('PAIRING_ENDPOINT_REFUSED');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(record.token ?? '') || !/^[0-9a-f]{16}$/.test(record.sessionId ?? '')) throw new Error('PAIRING_FILE_INVALID');
  if (Date.now() >= Date.parse(record.expiresAt)) throw new Error('PAIRING_EXPIRED');
  return record;
}

export function clearPairing() { sessionStorage.removeItem(STORAGE_KEY); }
export function storedPairing() {
  try { return validate(JSON.parse(sessionStorage.getItem(STORAGE_KEY))); } catch { clearPairing(); return null; }
}

export async function importPairing(file) {
  if (!file || file.size > 8192) throw new Error('PAIRING_FILE_INVALID');
  const record = validate(JSON.parse(await file.text()));
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  try { await connectorRequest('/session'); } catch (error) { clearPairing(); throw error; }
  return record;
}

export async function connectorRequest(path, { method = 'GET', body } = {}) {
  const record = storedPairing();
  if (!record) throw new Error('PAIRING_REQUIRED');
  if (!/^\/(?:session|profiles|deals(?:\/bbx-[0-9a-f]{16}(?:\/actions\/bbx-[0-9a-f]{16}-write-[1-6]\/(?:prepare|execute)|\/(?:refresh|finalize))?)?)$/.test(path)) throw new Error('CONNECTOR_ROUTE_REFUSED');
  const response = await fetch(`${record.connectorUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${record.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let value; try { value = await response.json(); } catch { throw new Error('CONNECTOR_RESPONSE_INVALID'); }
  if (!response.ok) throw new Error(value.error ?? `CONNECTOR_HTTP_${response.status}`);
  return value;
}

export async function connectionStatus() {
  if (!storedPairing()) {
    try {
      const response = await fetch('http://127.0.0.1:8787/health', { method: 'GET', credentials: 'omit', redirect: 'error' });
      const health = await response.json();
      return response.ok && health.status === 'CONNECTOR_FOUND' ? { state: 'PAIRING_REQUIRED' } : { state: 'CONNECTOR_OFFLINE' };
    } catch { return { state: 'CONNECTOR_OFFLINE' }; }
  }
  try { const session = await connectorRequest('/session'); return { state: 'CONNECTED', ...session }; }
  catch (error) { clearPairing(); return { state: 'CONNECTOR_UNAVAILABLE', error: error.message }; }
}
