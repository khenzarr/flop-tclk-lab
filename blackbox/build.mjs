import { access } from 'node:fs/promises';
import { buildWeb } from '../web/build.mjs';
await access(new URL('./ui/render.mjs', import.meta.url));
const web = await buildWeb();
console.log(`Blackbox build PASS (zero-dependency source; web ${web.events} verified events)`);
