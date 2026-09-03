import { execFileSync } from 'node:child_process';
const files=['blackbox/core/replay.mjs','blackbox/core/model.mjs','blackbox/ui/render.mjs','blackbox/demo.mjs'];
try {
  for(const file of files) execFileSync('node',['--check',file],{stdio:'inherit'});
  const model=await import('./core/model.mjs');
  for(const name of ['frameEvents','reconstruct','flightPath','boundary','laneTracks','invariantState','chaosResult','capsuleView']) if(typeof model[name] !== 'function') throw new TypeError(`${name} is not a function`);
  console.log(`typecheck PASS (${files.length} runtime-checked modules; forensic model exports verified)`);
} catch(error) { console.error(error.message); process.exit(1); }