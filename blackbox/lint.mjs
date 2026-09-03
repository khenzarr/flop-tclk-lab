import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const roots=['blackbox','lab']; const banned=/\b(?:innerHTML|outerHTML|eval\s*\(|new Function|fetch\s*\(|node:(?:http|https|child_process))\b/;
async function walk(dir){let out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory()&&e.name!=='out')out.push(...await walk(p));else if(e.isFile()&&/\.m?js$/.test(e.name))out.push(p)}return out}
const files=[];for(const root of roots)files.push(...await walk(root));let failed=false;for(const f of files){const text=await readFile(f,'utf8');if(banned.test(text)&&!f.endsWith('render.mjs')&&!f.endsWith('lint.mjs')&&!f.endsWith('typecheck.mjs')){console.error(`lint: banned construct in ${f}`);failed=true}if(/[ \t]+$/m.test(text)){console.error(`lint: trailing whitespace in ${f}`);failed=true}}
if(failed)process.exit(1);console.log(`lint PASS (${files.length} JS files)`);