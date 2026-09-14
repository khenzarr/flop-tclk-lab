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
  const publication = make('section', 'identity-console workload-record-card publication-card');
  publication.append(make('p', 'section-kicker', 'Optional · W2'), make('h2', '', 'Publish signed result'),
    make('p', 'tool-note', 'Prepare a self-published assertion for this exact W1 result. Preparation burns one local nonce. Signing and the one public POST remain separate terminal-approved actions.'));
  const setup = make('div', 'publication-setup');
  const venueLabel = make('label', '', 'Venue origin'); const venue = make('input'); venue.value = 'https://technocore.chat'; venueLabel.append(venue);
  const roomLabel = make('label', '', 'Private room'); const room = make('input'); room.placeholder = 'room-name'; roomLabel.append(room);
  const signerLabel = make('label', '', 'Existing signer DID'); const signer = make('input'); signer.placeholder = 'did:key:z6Mk…'; signerLabel.append(signer);
  const prepare = make('button', 'button button-quiet', 'Prepare exact publication'); prepare.type = 'button'; setup.append(venueLabel, roomLabel, signerLabel, prepare);
  const stage = make('div', 'publication-stage'); stage.hidden = true; const status = make('strong', '', 'APPROVAL PENDING');
  const approvalLead = make('p', 'publication-approval-lead', 'You are approving exactly this publication.');
  const preview = make('div', 'publication-preview'); const warning = make('p', 'tool-note', 'Signing does not submit. Any change requires a fresh approval; the reserved nonce will never be reused.');
  const actions = make('div', 'publication-actions');
  const sign = make('button', 'button button-primary', 'Approve exact publication · sign locally'); sign.type = 'button';
  const cancel = make('button', 'button button-quiet', 'Cancel and burn reserved nonce'); cancel.type = 'button';
  const submit = make('button', 'button button-primary', 'Submit once'); submit.type = 'button'; submit.disabled = true;
  const observe = make('button', 'button button-quiet', 'Check public evidence'); observe.type = 'button'; observe.disabled = true;
  actions.append(sign, cancel, submit, observe); stage.append(status, approvalLead, preview, warning, actions); publication.append(setup, stage);
  let operationId = null; let expiryTimer = null; let renderedPublication = null;
  const approvalRow = (label, value) => { const row = make('div'); row.append(make('dt', '', label), make('dd', '', value)); return row; };
  const approvalGroup = (title, rows) => { const group = make('section', 'publication-review-group'); group.append(make('h3', '', title));
    const details = make('dl', 'publication-review-details'); for (const [label, value] of rows) details.append(approvalRow(label, value)); group.append(details); return group; };
  const approvalBindingMatches = value => {
    const candidate = value.signApproval?.candidate;
    return candidate?.operationId === value.operationId && candidate?.evidenceArtifactSha256 === value.evidenceArtifactSha256
      && candidate?.targetVenueOrigin === value.venueOrigin && candidate?.targetRoom === value.room && candidate?.signerDid === value.signerDid
      && candidate?.nonce === value.nonce && candidate?.signedText === value.signedText && candidate?.signedTextSha256 === value.signedTextSha256;
  };
  const refreshApprovalExpiry = () => {
    if (!renderedPublication) return;
    const expiresAt = renderedPublication.signApproval?.candidate?.approvalExpiresAt;
    const expired = typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.now() > Date.parse(expiresAt);
    const bindingValid = approvalBindingMatches(renderedPublication);
    status.textContent = !bindingValid ? 'APPROVAL BINDING INVALID' : expired && renderedPublication.state === 'APPROVAL_PENDING'
      ? 'APPROVAL PENDING · EXPIRED' : renderedPublication.state;
    sign.disabled = renderedPublication.state !== 'APPROVAL_PENDING' || expired || !bindingValid;
  };
  const renderPublication = value => {
    operationId = value.operationId; renderedPublication = value; stage.hidden = false;
    const candidate = value.signApproval?.candidate ?? {};
    const signedText = candidate.signedText ?? '';
    const signedTextGroup = make('section', 'publication-review-group publication-signed-text');
    const signedTextHead = make('div', 'publication-signed-text-head'); signedTextHead.append(make('h3', '', 'Exact canonical signed text'));
    const copySignedText = make('button', 'copy-mini publication-copy', 'Copy'); copySignedText.type = 'button'; copySignedText.setAttribute('aria-label', 'Copy exact canonical signed text');
    copySignedText.addEventListener('click', async () => { try { await navigator.clipboard.writeText(signedText); copySignedText.textContent = 'Copied'; }
      catch { copySignedText.textContent = 'Select text to copy'; } });
    signedTextHead.append(copySignedText); signedTextGroup.append(signedTextHead, make('pre', 'publication-canonical-text', signedText));
    preview.replaceChildren(
      approvalGroup('W1 validation evidence', [['Result', value.assertion?.verdict ?? 'UNAVAILABLE'], ['W1 workload ID', value.assertion?.workloadId ?? 'UNAVAILABLE'],
        ['Evidence artifact SHA-256', candidate.evidenceArtifactSha256 ?? 'UNAVAILABLE']]),
      approvalGroup('Publication destination', [['Venue', candidate.targetVenueOrigin ?? 'UNAVAILABLE'], ['Room', candidate.targetRoom ?? 'UNAVAILABLE']]),
      approvalGroup('Local signer and nonce', [['Signer DID', candidate.signerDid ?? 'UNAVAILABLE'], ['Nonce', candidate.nonce ?? 'UNAVAILABLE']]),
      approvalGroup('Assertion', [['Schema / version', value.assertion?.schema ?? 'UNAVAILABLE'], ['Signed text SHA-256', candidate.signedTextSha256 ?? 'UNAVAILABLE']]),
      signedTextGroup,
      approvalGroup('Operation binding', [['Operation ID', candidate.operationId ?? 'UNAVAILABLE'], ['Approval hash', value.signApproval?.approvalHash ?? 'UNAVAILABLE'],
        ['Approval issued at', candidate.approvalIssuedAt ?? 'UNAVAILABLE'], ['Approval expires at', candidate.approvalExpiresAt ?? 'UNAVAILABLE']]),
    );
    if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    refreshApprovalExpiry();
    if (value.state === 'APPROVAL_PENDING' && Number.isFinite(Date.parse(candidate.approvalExpiresAt))) {
      const remaining = Date.parse(candidate.approvalExpiresAt) - Date.now() + 1;
      if (remaining > 0) expiryTimer = window.setTimeout(refreshApprovalExpiry, remaining);
    }
    cancel.disabled = value.state !== 'APPROVAL_PENDING'; submit.disabled = !['SIGNED', 'SIGNED_NOT_SUBMITTED'].includes(value.state);
    observe.disabled = !['ACK_RECEIVED', 'SUBMISSION_UNCERTAIN', 'OBSERVED_PUBLIC', 'COMPLETE'].includes(value.state);
    if (value.state === 'SUBMISSION_UNCERTAIN') warning.textContent = 'The POST outcome is uncertain. BLACKBOX will not retry. Only read-only public observation is available.';
    if (value.duplicateMatchAnomaly === 'DUPLICATE_PUBLIC_MATCH') warning.textContent = 'Observed publicly, with a DUPLICATE_PUBLIC_MATCH replay anomaly. Duplicates do not count as extra work.';
  };
  prepare.addEventListener('click', async () => { prepare.disabled = true; try { renderPublication(await connectorRequest(`/workloads/${id}/publication/prepare`, { method: 'POST', body: { venueOrigin: venue.value.trim(), room: room.value.trim(), signerDid: signer.value.trim() } })); setup.hidden = true; } catch (error) { status.textContent = error.message; stage.hidden = false; prepare.disabled = false; } });
  sign.addEventListener('click', async () => { sign.disabled = true; try { renderPublication(await connectorRequest(`/workloads/${id}/publication/${operationId}/sign`, { method: 'POST' })); } catch (error) { status.textContent = error.message; } });
  cancel.addEventListener('click', async () => { cancel.disabled = true; try { renderPublication(await connectorRequest(`/workloads/${id}/publication/${operationId}/cancel`, { method: 'POST' })); } catch (error) { status.textContent = error.message; cancel.disabled = false; } });
  submit.addEventListener('click', async () => { submit.disabled = true; try { renderPublication(await connectorRequest(`/workloads/${id}/publication/${operationId}/submit`, { method: 'POST' })); } catch (error) { status.textContent = error.message; } });
  observe.addEventListener('click', async () => { observe.disabled = true; try { renderPublication(await connectorRequest(`/workloads/${id}/publication/${operationId}/observe`, { method: 'POST' })); } catch (error) { status.textContent = error.message; observe.disabled = false; } });
  main.replaceChildren(top, card, checks, limits, ...(response.publicationEnabled === true ? [publication] : []), download);
  document.querySelector('dialog')?.remove();
} catch {
  main.replaceChildren(make('section', 'page-title identity-title', 'Local validation Flight Record unavailable. Pair and reconnect the localhost connector.'));
}
