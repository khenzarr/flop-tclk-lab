import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONNECTOR_HOST, DEFAULT_ALLOWED_ORIGINS, connectorStartupMessages, createConnector } from '../hub/connector.mjs';

const productionOrigin = 'https://tclk-blackbox.vercel.app';

test('production and local defaults remain exact, loopback-only and authenticated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blackbox-production-origin-'));
  let liveNetworkCalls = 0;
  const connector = await createConnector({ root, port: 0, transport: async () => { liveNetworkCalls += 1; throw new Error('LIVE_NETWORK_REFUSED'); } });
  const server = connector.createServer();
  await new Promise(resolve => server.listen(0, CONNECTOR_HOST, resolve));
  try {
    assert.deepEqual(DEFAULT_ALLOWED_ORIGINS, [
      'http://127.0.0.1:4173',
      'http://localhost:4173',
      productionOrigin,
    ]);
    assert.equal(DEFAULT_ALLOWED_ORIGINS.some(origin => origin.includes('*')), false);
    assert.equal(server.address().address, CONNECTOR_HOST);
    assert.equal(connectorStartupMessages(connector, 'real', 8787).join('\n').includes(connector.pairing.record.token), false);
    const base = `http://${CONNECTOR_HOST}:${server.address().port}`;

    for (const origin of DEFAULT_ALLOWED_ORIGINS) {
      const response = await fetch(`${base}/health`, { headers: { origin } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(JSON.stringify(await response.json()).includes(connector.pairing.record.token), false);
    }

    for (const origin of ['https://evil.example', 'https://blackbox-preview-123.vercel.app']) {
      const response = await fetch(`${base}/health`, { headers: { origin } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(JSON.stringify(await response.json()).includes(connector.pairing.record.token), false);
    }

    const preflight = await fetch(`${base}/health`, { method: 'OPTIONS', headers: {
      origin: productionOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-private-network': 'true',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), productionOrigin);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    const privileged = await fetch(`${base}/profiles`, { headers: { origin: productionOrigin } });
    assert.equal(privileged.status, 401);
    const privilegedBody = await privileged.json();
    assert.equal(privilegedBody.error, 'PAIRING_REQUIRED');
    assert.equal(JSON.stringify(privilegedBody).includes(connector.pairing.record.token), false);
    assert.equal(liveNetworkCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
