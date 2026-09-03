import { access } from 'node:fs/promises';
await access(new URL('./ui/render.mjs', import.meta.url));
console.log('Blackbox build PASS (zero-dependency source; run pnpm demo for artifact)');