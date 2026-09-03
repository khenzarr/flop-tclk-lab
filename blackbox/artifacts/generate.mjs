import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixtures } from '../fixtures/index.mjs';
import { replay } from '../core/replay.mjs';
import { makeCapsule } from '../core/capsule.mjs';
import { frameEvents, reconstruct, invariantState, chaosResult, capsuleView } from '../core/model.mjs';
import { render } from '../ui/render.mjs';

const out=resolve('blackbox/artifacts/phase-2.1');
const specs=[
  ['happy-claim-terminal','happy-claim'],
  ['wrong-secret-rejection-boundary','wrong-secret'],
  ['replay-attack-rejection','replay-attack'],
  ['mutated-canonical-frame-rejection','mutated-canonical-frame',0],
  ['mid-replay-scrub','happy-claim',1],
  ['chaos-lab','out-of-order-reveal'],
  ['evidence-capsule-drawer','happy-claim',undefined,true]
];

function record(id,initialFrame,initialDrawer){const f=fixtures[id](),result=replay(f.lines,{nowMs:f.nowMs}),capsule=makeCapsule(result);return {id,name:f.name,description:f.description,invariant:f.invariant,result,capsule,events:frameEvents(result),models:result.steps.map(x=>({...reconstruct(result,x.index),invariant:invariantState({invariant:f.invariant,result},x.index)})),chaos:chaosResult({name:f.name,invariant:f.invariant,result}),capsuleView:capsuleView(capsule),initialFrame,initialDrawer}}

await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const [name,id,initialFrame,initialDrawer] of specs)await writeFile(join(out,`${name}.html`),render([record(id,initialFrame,initialDrawer)]),'utf8');
await writeFile(join(out,'README.md'),`# Phase 2.1 visual acceptance\n\nGenerated deterministically from local replay fixtures with \`node blackbox/artifacts/generate.mjs\`. Each PNG has a matching standalone HTML source.\n\n${specs.map(([name,id,frame,drawer])=>`- [${name}.png](./${name}.png) — ${id}${Number.isInteger(frame)?`, frame ${frame+1}`:''}${drawer?', capsule open':''}`).join('\n')}\n`,'utf8');
console.log(`visual artifact sources PASS (${specs.length} views): ${out}`);