import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(webDir, '..');
const sourceCapsule = join(repoRoot, 'evidence', 'public', 'phase3b-final-public-capsule.json');
const sourceHash = join(repoRoot, 'evidence', 'public', 'phase3b-final-public-capsule.sha256');
const expectedCapsuleSha256 = '8337b483c26bd4cb06c12b3a5e9523d595a0a2d023acd1923eebb263d03ccc02';
const expectedSteps = ['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildWeb({ outDir = join(repoRoot, 'dist') } = {}) {
  const [capsuleBytes, hashText] = await Promise.all([readFile(sourceCapsule), readFile(sourceHash, 'utf8')]);
  const capsuleSha256 = sha256(capsuleBytes);
  if (capsuleSha256 !== expectedCapsuleSha256 || !hashText.startsWith(`${capsuleSha256}  `)) throw new Error('WEB_PUBLIC_CAPSULE_INTEGRITY_REFUSED');
  const capsule = JSON.parse(capsuleBytes.toString('utf8'));
  if (capsule.schema !== 'tclk-blackbox/public-evidence-capsule/v1'
    || capsule.deal.manifestRoot !== '887eb9996c701260e5d78f1798b6577f62575db20a625bcaee7b12523d3ecd2f'
    || capsule.summary.verifiedSteps !== 6 || capsule.summary.unresolvedSteps !== 0
    || JSON.stringify(capsule.flightRecord.map(item => item.step)) !== JSON.stringify(expectedSteps)) {
    throw new Error('WEB_PUBLIC_CAPSULE_CONTRACT_REFUSED');
  }

  const assetsDir = join(outDir, 'assets');
  const evidenceDir = join(outDir, 'evidence');
  const referenceDir = join(outDir, 'deal', 'phase3b-final');
  const newDealDir = join(outDir, 'deal', 'new');
  const liveDealDir = join(outDir, 'deal', 'live');
  const recordsDir = join(outDir, 'records');
  await Promise.all([mkdir(assetsDir, { recursive: true }), mkdir(evidenceDir, { recursive: true }), mkdir(referenceDir, { recursive: true }), mkdir(newDealDir, { recursive: true }), mkdir(liveDealDir, { recursive: true }), mkdir(recordsDir, { recursive: true })]);
  await Promise.all([
    copyFile(join(webDir, 'hub.html'), join(outDir, 'index.html')),
    copyFile(join(webDir, 'index.html'), join(referenceDir, 'index.html')),
    copyFile(join(webDir, 'new-deal.html'), join(newDealDir, 'index.html')),
    copyFile(join(webDir, 'live-deal.html'), join(liveDealDir, 'index.html')),
    copyFile(join(webDir, 'records.html'), join(recordsDir, 'index.html')),
    copyFile(join(webDir, 'styles.css'), join(assetsDir, 'styles.css')),
    copyFile(join(webDir, 'app.js'), join(assetsDir, 'app.js')),
    copyFile(join(webDir, 'hub-app.js'), join(assetsDir, 'hub-app.js')),
    copyFile(join(webDir, 'connector-client.js'), join(assetsDir, 'connector-client.js')),
    copyFile(join(webDir, 'public-capsule-adapter.js'), join(assetsDir, 'public-capsule-adapter.js')),
    copyFile(sourceCapsule, join(evidenceDir, 'phase3b-final-public-capsule.json')),
    copyFile(sourceHash, join(evidenceDir, 'phase3b-final-public-capsule.sha256')),
    writeFile(join(assetsDir, 'capsule.js'), `export default ${JSON.stringify(capsule)};\n`),
  ]);
  return Object.freeze({ capsuleSha256, events: capsule.flightRecord.length, routes: 5, output: outDir });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildWeb();
  process.stdout.write(`web build PASS (${result.events} verified events)\n`);
}
