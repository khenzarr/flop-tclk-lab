import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, fixtureList, replayFixture } from '../fixtures/index.mjs';
import { replay } from '../core/replay.mjs';
import { makeCapsule } from '../core/capsule.mjs';
import { frameEvents, reconstruct, invariantState, chaosResult, capsuleView } from '../core/model.mjs';
import { render } from '../ui/render.mjs';

const record=id=>{const f=fixtures[id]();const result=replayFixture(f);return {id,name:f.name,invariant:f.invariant,result,capsule:makeCapsule(result)}};

test('rejected frames never render state advancement and preserve before/after',()=>{
  for(const id of fixtureList){const r=record(id);for(const step of r.result.steps.filter(x=>!x.ok)){const m=reconstruct(r.result,step.index);assert.equal(m.boundary.stateAdvanced,false);assert.equal(m.boundary.stateUnchanged,true);assert.equal(m.boundary.before,m.boundary.after);assert.equal(m.path.filter(x=>x.reached).length,r.result.steps.slice(0,step.index+1).filter(x=>x.ok).length)}}
});

test('accepted frames advance only according to replay result',()=>{
  const r=record('happy-claim');for(const step of r.result.steps.filter(x=>x.ok)){const m=reconstruct(r.result,step.index);assert.deepEqual(m.state,step.stateAfter);assert.equal(m.boundary.after,step.stateAfter.status);assert.equal(m.boundary.stateAdvanced,step.stateBefore?.status!==step.stateAfter?.status)}
});

test('timeline and rejected markers exactly equal replay evidence counts',()=>{
  for(const id of fixtureList){const r=record(id),events=frameEvents(r.result);assert.equal(events.length,r.result.steps.length);assert.equal(events.filter(x=>x.rejected).length,r.result.steps.filter(x=>!x.ok).length)}
});

test('lane events are derived only from visible replay evidence',()=>{
  const r=record('happy-claim');for(let i=0;i<r.result.steps.length;i++){const m=reconstruct(r.result,i);assert.ok(m.lanes.protocol.every(x=>x.index<=i));assert.ok(m.lanes.custody.every(x=>x.index<=i));assert.ok(m.lanes.rail.every(x=>x.index<=i));assert.deepEqual(m.lanes.rail.map(x=>x.index),r.result.steps.slice(0,i+1).filter(x=>x.ok&&['lock','receipt'].includes(x.type)&&x.stateAfter?.rail).map(x=>x.index))}
});

test('evidence capsule UI projection uses actual capsule data',()=>{
  const r=record('wrong-secret'),v=capsuleView(r.capsule);assert.equal(v.upstreamSha,r.capsule.upstreamSha);assert.equal(v.replayFingerprint,r.capsule.replayFingerprint);assert.equal(v.frameCount,r.capsule.frameCount);assert.equal(v.acceptedCount,r.capsule.acceptedFrameCount);assert.equal(v.rejectedCount,r.capsule.rejectedFrameCount);assert.equal(v.terminalState,r.capsule.terminalState);assert.equal(v.completenessWarning,r.capsule.completenessLimitations.join(' '))
});

test('CHAOS expected/actual comparison uses the injected rejection boundary',()=>{
  for(const id of fixtureList.slice(3)){const r=record(id),q=chaosResult(r);const rejected=r.result.steps.find(x=>!x.ok),before=(rejected.stateBefore?.status||'no contract state').toUpperCase(),after=(rejected.stateAfter?.status||'no contract state').toUpperCase();assert.equal(q.expectedInvariant,r.invariant);assert.equal(q.boundaryIndex,rejected.index);assert.equal(q.before,before);assert.equal(q.after,after);assert.equal(q.stateMutated,false);assert.equal(q.pass,true)}
});

test('scrubbing to frame N reconstructs exactly frame N state',()=>{
  for(const id of fixtureList){const r=record(id);r.result.steps.forEach((step,n)=>{const m=reconstruct(r.result,n);assert.equal(m.frameIndex,n);assert.deepEqual(m.state,step.stateAfter);assert.equal(m.events.length,n+1)})}
});

test('reduced motion preserves textual and structural information',()=>{
  const r=record('wrong-secret'),base={...r,description:'test',events:frameEvents(r.result),models:r.result.steps.map(x=>({...reconstruct(r.result,x.index),invariant:invariantState(r,x.index)})),chaos:chaosResult(r),capsuleView:capsuleView(r.capsule)};const html=render([base]);assert.match(html,/@media\(prefers-reduced-motion:reduce\)/);assert.match(html,/animation:none!important/);assert.match(html,/FRAME REJECTED · STATE UNCHANGED/);assert.match(html,/aria-label':'Frame/)
});