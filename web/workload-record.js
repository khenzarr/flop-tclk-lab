import { connectorRequest } from './connector-client.js';

const id = location.pathname.match(/^\/deal\/record\/(w1-[0-9a-f]{32})\/?$/)?.[1];
const make = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
const main = document.querySelector('main');
document.title = 'Local validation Flight Record · TCLK BLACKBOX';
document.querySelector('footer .section-shell > p').textContent = 'TCLK BLACKBOX · Local validation evidence';
document.getElementById('footer-record-id').textContent = id;
try {
  const response = await connectorRequest(`/workloads/${id}/record`);
  const record = response.record; const evidence = record.artifact;
  if (record.executionType !== 'LOCAL_VALIDATION' || record.transportStates?.length !== 0 || evidence.schema !== 'blackbox/workload-evidence/v1') throw new Error('LOCAL_RECORD_INVALID');
  const top = make('section', 'page-title identity-title');
  top.append(make('p', 'section-kicker', 'Flight Record · local validation'), make('h1', '', 'One transcript. One bounded verdict.'),
    make('p', '', 'This record preserves local computation evidence. No message was signed, submitted, acknowledged or observed as a result of W1.'));
  const card = make('section', 'identity-console workload-record-card');
  card.append(make('p', 'section-kicker', evidence.workloadType), make('h2', '', evidence.verdict),
    make('p', '', `Supplied-window coverage: ${evidence.coverage.windowStatus}. Complete room history is not proven.`));
  const details = make('dl', 'workload-details');
  for (const [label, value] of [['Workload ID', evidence.workloadId], ['Input SHA-256', evidence.input.sha256], ['Input bytes', String(evidence.input.byteLength)],
    ['Verified signed rows', String(evidence.summary.signedVerified)], ['Unsigned context', String(evidence.summary.unsignedContext)],
    ['Generation', evidence.coverage.generation.status], ['Verifier', evidence.verifier.id], ['Verifier digest', evidence.verifier.implementationDigest]]) {
    const row = make('div'); row.append(make('dt', '', label), make('dd', '', value)); details.append(row);
  }
  card.append(details);
  const checks = make('section', 'identity-console workload-record-card'); checks.append(make('h2', '', 'Verification checks'));
  const list = make('ul', 'workload-checks'); for (const check of evidence.checks) list.append(make('li', '', `${check.id} · ${check.status} · ${check.dimension}`)); checks.append(list);
  const limits = make('p', 'tool-note', `Limitations: ${evidence.limitations.join(', ')}. Room name and raw transcript are not in this public-safe record.`);
  const download = make('a', 'button button-quiet', 'Download public-safe evidence');
  download.href = URL.createObjectURL(new Blob([`${JSON.stringify(evidence, null, 2)}\n`], { type: 'application/json' }));
  download.download = `${id}-workload-evidence.json`;
  main.replaceChildren(top, card, checks, limits, download);
  document.querySelector('dialog')?.remove();
} catch {
  main.replaceChildren(make('section', 'page-title identity-title', 'Local validation Flight Record unavailable. Pair and reconnect the localhost connector.'));
}
