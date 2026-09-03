// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — operator surface.
//
// This is a separate surface from the accepted forensic interface: the flight recorder is
// untouched. The metaphor here is a pressure door, not a signing form. Five doors, in order,
// and a door only opens if every door behind it is open.
//
// The page is static: no client script, no network, no clipboard, no posting affordance. Every
// scenario is a <details> chamber so the whole surface works with keyboard alone.

const esc = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DOOR_GLYPH = { true: '\u25AC', false: '\u2716' };

/** Wrap the exact canonical bytes so long payloads stay readable without inserting characters. */
const byteBlock = payload => `<pre class="bytes" tabindex="0" aria-label="Exact canonical bytes">${esc(payload)}</pre>`;

function doorStrip(doors) {
  const cells = doors.map((door, index) => `
        <li class="door ${door.open ? 'open' : 'shut'}">
          <span class="seal" aria-hidden="true">${DOOR_GLYPH[door.open]}</span>
          <span class="door-name">${index + 1}. ${esc(door.door)}</span>
          <span class="door-detail">${esc(door.open ? door.detail : door.detail ?? 'HELD SHUT')}</span>
        </li>`).join('');
  return `<ol class="doors" aria-label="Airlock doors, in order">${cells}\n      </ol>`;
}

function humanPanel(request) {
  const rows = request.human.fields.map(field => `
          <div class="row"><span>${esc(field.label)}</span><span>${esc(field.value)}</span></div>`).join('');
  return `
      <section class="pane human" aria-label="Human interpretation">
        <h4>HUMAN INTERPRETATION <em>advisory only</em></h4>
        <p class="meaning">${esc(request.human.meaning)}</p>
        <div class="rows">${rows}
        </div>
      </section>`;
}

function bytesPane(request) {
  return `
      <section class="pane exact" aria-label="Exact signed bytes">
        <h4>EXACT SIGNED BYTES <em>this is what a signature covers</em></h4>
        ${byteBlock(request.canonicalPayload)}
        <div class="rows">
          <div class="row"><span>SHA-256</span><span class="hash">${esc(request.canonicalHash)}</span></div>
          <div class="row"><span>LENGTH</span><span>${esc(request.payloadBytes)} bytes</span></div>
          <div class="row"><span>SIGNATURE INPUT</span><span>room | nonce | these bytes</span></div>
        </div>
      </section>`;
}

function findings(verification, eligibility) {
  const items = [
    ...verification.findings.map(f => ['finding', f]),
    ...eligibility.blockers.map(b => ['blocker', b]),
  ];
  if (items.length === 0) {
    return '<p class="clean">No findings. The returned signature covers exactly the approved bytes.</p>';
  }
  return `<ul class="findings">${items.map(([kind, text]) =>
    `\n          <li class="${kind}">${esc(text)}</li>`).join('')}\n        </ul>`;
}

function chamber(scenario, index) {
  const { request, approval, response, verification, eligibility } = scenario;
  const eligible = eligibility.postEligible;
  return `
  <details class="chamber ${eligible ? 'eligible' : 'refused'}"${index === 0 ? ' open' : ''}>
    <summary>
      <span class="verdict">POST_ELIGIBLE = ${eligible ? 'YES' : 'NO'}</span>
      <span class="chamber-name">${esc(scenario.name)}</span>
      <span class="chamber-id">${esc(scenario.id)}</span>
    </summary>
    <div class="chamber-body">
      ${doorStrip(scenario.doors)}
      <div class="dual">
        ${humanPanel(request)}
        ${bytesPane(request)}
      </div>
      <p class="load-bearing">The signature covers the exact canonical bytes, not the human
        interpretation. TCLK canonicalization is load-bearing: if the two ever disagree, the bytes
        are the truth.</p>
      <section class="pane handoff" aria-label="Custody handoff">
        <h4>CUSTODY HANDOFF</h4>
        <div class="rows">
          <div class="row"><span>REQUEST ID</span><span class="hash">${esc(request.requestId)}</span></div>
          <div class="row"><span>REQUEST FINGERPRINT</span><span class="hash">${esc(request.requestFingerprint)}</span></div>
          <div class="row"><span>OPERATOR SAID</span><span>${esc(approval.acknowledgement || '— NOTHING —')}</span></div>
          <div class="row"><span>BYTE FREEZE</span><span class="${verification.byteFreezeIntact ? 'ok' : 'bad'}">${verification.byteFreezeIntact ? 'INTACT' : 'BROKEN'}</span></div>
          <div class="row"><span>SIGNER KIND</span><span>${esc(response.signerKind)}</span></div>
          <div class="row"><span>SIGNER DID</span><span class="hash">${esc(response.signerDid)}</span></div>
          <div class="row"><span>ROOM / NONCE</span><span>${esc(response.room)} / ${esc(response.nonce)}</span></div>
          <div class="row"><span>SIGNATURE VERIFIES</span><span class="${verification.signatureValid ? 'ok' : 'bad'}">${verification.signatureValid ? 'YES' : 'NO'}</span></div>
        </div>
        ${findings(verification, eligibility)}
      </section>
      <p class="statement">${esc(eligibility.statement)}</p>
    </div>
  </details>`;
}

/**
 * @param {Array<object>} scenarios output of dryrun.runAll()
 * @param {{upstreamSha?: string}} [meta]
 */
export function renderAirlock(scenarios, meta = {}) {
  const upstream = meta.upstreamSha ?? scenarios[0]?.request.upstream.sha ?? 'unknown';
  const eligibleCount = scenarios.filter(s => s.eligibility.postEligible).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'">
<title>TCLK BLACKBOX · SIGNATURE AIRLOCK</title>
<style>${css}</style>
</head>
<body>
<a class="skip" href="#chambers">Skip to airlock chambers</a>
<header class="masthead">
  <div>
    <span class="label">TCLK BLACKBOX · SEPARATE SURFACE</span>
    <h1>SIGNATURE AIRLOCK</h1>
    <p class="sub">A deterministic local handoff between TCLK frame preparation and a trusted
      local signer. The airlock holds no key, and it never posts.</p>
  </div>
  <div class="stamps">
    <p class="stamp danger">PUBLIC POSTING DISABLED</p>
    <p class="stamp">PHASE 3A · ${esc(eligibleCount)} / ${esc(scenarios.length)} ELIGIBLE</p>
    <p class="stamp">UPSTREAM PIN ${esc(String(upstream).slice(0, 7))}</p>
  </div>
</header>
<p class="creed">POST ELIGIBLE is not POSTED. Eligibility is a statement about local readiness:
  the bytes were reviewed, frozen, signed outside TCLK, and verified here. Nothing has crossed the
  network, no room has been written, and no value has moved.</p>
<main id="chambers" tabindex="-1">${scenarios.map(chamber).join('\n')}
</main>
<footer>
  <p>Key custody is structurally outside this surface: the airlock hands over a challenge and
    receives a signature. It never receives a seed, a passphrase, or a decrypted key, and the
    response envelope has no field that could carry one.</p>
  <p>Signatures on this page come from a published deterministic test vector, not from the
    trusted local signer.</p>
</footer>
</body>
</html>
`;
}

const css = `:root{--bg:#070a0d;--panel:#111820;--line:#2b3742;--text:#edf3f3;--muted:#8b99a3;--ok:#71e9c8;--bad:#ff716f;--warn:#ffd166;--mono:Consolas,"Cascadia Code",monospace}
*{box-sizing:border-box}html{background:var(--bg);color-scheme:dark}
body{margin:0;padding:0 clamp(14px,3vw,44px) 60px;background:
repeating-linear-gradient(135deg,#ffd1660a 0 12px,transparent 12px 26px) top/100% 8px no-repeat,
radial-gradient(circle at 78% -8%,#1b2a3a,transparent 42%),var(--bg);
color:var(--text);font-family:system-ui,sans-serif;line-height:1.5}
.skip{position:fixed;top:-99px;left:10px;background:#fff;color:#000;padding:8px;z-index:9}.skip:focus{top:10px}
:focus-visible{outline:2px solid #fff;outline-offset:2px}
.label{display:block;color:var(--muted);font:700 9px var(--mono);letter-spacing:.18em}
h1{margin:6px 0 4px;font-size:clamp(26px,4vw,46px);letter-spacing:-.03em}
.sub{margin:0;max-width:60ch;color:var(--muted);font-size:12px}
.masthead{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:26px 0 18px;border-bottom:1px solid var(--line)}
.stamps{display:grid;gap:7px;align-content:start}
.stamp{margin:0;border:1px solid var(--line);padding:8px 10px;font:800 9px var(--mono);letter-spacing:.12em;text-align:center}
.stamp.danger{border-color:var(--bad);color:var(--bad);background:#ff716f14}
.creed{max-width:96ch;margin:18px 0 22px;color:var(--muted);font-size:11px;border-left:2px solid var(--warn);padding-left:12px}
.chamber{border:1px solid var(--line);background:var(--panel);margin-bottom:13px}
.chamber.eligible{border-left:3px solid var(--ok)}.chamber.refused{border-left:3px solid var(--bad)}
summary{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:15px 17px;cursor:pointer;font:800 11px var(--mono);letter-spacing:.06em}
summary::marker{color:var(--muted)}
.verdict{font:900 10px var(--mono);letter-spacing:.1em;border:1px solid currentColor;padding:5px 8px}
.eligible .verdict{color:var(--ok)}.refused .verdict{color:var(--bad)}
.chamber-name{font-size:14px;letter-spacing:0}
.chamber-id{color:var(--muted);font-weight:600}
.chamber-body{padding:0 17px 20px}
.doors{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 16px;padding:0}
.door{border:1px dashed var(--line);padding:11px;display:grid;gap:5px;background:#0a0f14}
.door.open{border-style:solid;border-color:var(--ok);background:#10211e}
.door.shut{border-color:var(--bad);background:#1c1113}
.seal{font:900 13px var(--mono)}.door.open .seal{color:var(--ok)}.door.shut .seal{color:var(--bad)}
.door-name{font:800 9px var(--mono);letter-spacing:.09em}
.door-detail{color:var(--muted);font:600 9px/1.45 var(--mono);word-break:break-word}
.dual{display:grid;grid-template-columns:1fr 1.35fr;gap:12px}
.pane{border:1px solid var(--line);padding:14px;background:#0c1116;min-width:0}
.pane h4{margin:0 0 10px;font:800 10px var(--mono);letter-spacing:.12em}
.pane h4 em{color:var(--muted);font:600 9px var(--mono);letter-spacing:.06em;font-style:normal;display:block;margin-top:4px}
.human{border-top:2px solid var(--muted)}.exact{border-top:2px solid var(--warn)}
.meaning{margin:0 0 12px;font-size:12px}
.bytes{margin:0;padding:12px;background:#05080b;border:1px solid var(--line);color:var(--warn);
font:600 11px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto}
.rows{display:grid}
.row{display:grid;grid-template-columns:minmax(110px,150px) 1fr;gap:10px;padding:8px 0;border-top:1px solid var(--line);font:600 10px/1.5 var(--mono);overflow-wrap:anywhere}
.row span:first-child{color:var(--muted);letter-spacing:.08em}
.hash{color:var(--warn)}.ok{color:var(--ok);font-weight:800}.bad{color:var(--bad);font-weight:800}
.load-bearing{margin:12px 0;color:var(--muted);font-size:11px;border-left:2px solid var(--warn);padding-left:11px;max-width:92ch}
.handoff{margin-top:12px}
.findings{list-style:none;margin:13px 0 0;padding:0;display:grid;gap:6px}
.findings li{border-left:3px solid var(--bad);padding:8px 10px;background:#1c1113;font:700 10px var(--mono);overflow-wrap:anywhere}
.findings .blocker{border-color:var(--warn);background:#211d11}
.clean{margin:13px 0 0;color:var(--ok);font:700 10px var(--mono)}
.statement{margin:14px 0 0;color:var(--muted);font-size:11px;max-width:96ch}
footer{margin-top:26px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted);font-size:11px;max-width:96ch}
@media(max-width:820px){.dual{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
