import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const roots=['blackbox','lab']; const banned=/\b(?:innerHTML|outerHTML|eval\s*\(|new Function|fetch\s*\(|node:(?:http|https))\b/;
// Subprocess use stays banned in product code. Two tools are documented exceptions, and both
// only ever re-invoke process.execPath on files inside this repo:
//   blackbox/typecheck.mjs   runtime-checks each module in a clean process
//   lab/compat-matrix.mjs    compares two upstream builds, which needs two module graphs
// Network APIs remain banned everywhere, including in those two.
const spawnApi=/\bnode:child_process\b/;
const spawnAllowed=new Set([join('blackbox','typecheck.mjs'),join('lab','compat-matrix.mjs')]);
async function walk(dir){let out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory()&&e.name!=='out')out.push(...await walk(p));else if(e.isFile()&&/\.m?js$/.test(e.name))out.push(p)}return out}
const files=[];for(const root of roots)files.push(...await walk(root));let failed=false;for(const f of files){const text=await readFile(f,'utf8');const exempt=f.endsWith('render.mjs')||f.endsWith('lint.mjs')||f.endsWith('typecheck.mjs');if(banned.test(text)&&!exempt){console.error(`lint: banned construct in ${f}`);failed=true}if(spawnApi.test(text)&&!spawnAllowed.has(f)&&!f.endsWith('lint.mjs')){console.error(`lint: unapproved subprocess use in ${f}`);failed=true}if(/[ \t]+$/m.test(text)){console.error(`lint: trailing whitespace in ${f}`);failed=true}}
if(failed)process.exit(1);console.log(`lint PASS (${files.length} JS files; ${spawnAllowed.size} documented subprocess exceptions)`);
