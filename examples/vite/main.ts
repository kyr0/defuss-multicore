import { createPool } from 'defuss-multicore';
import type { Tasks } from './worker.js';
import { createGenerator, makeJobs } from '../shared/chunks.mjs';
const output = document.querySelector('pre')!;
const button = document.querySelector('button')!;
const status = document.querySelector('#status')!;
let frames = 0;
function animate() { frames++; status.textContent = `UI frames: ${frames}`; requestAnimationFrame(animate); }
requestAnimationFrame(animate);
async function run() {
  button.disabled = true;
  const jobs = makeJobs(48);
  const local = createGenerator(42);
  const baselineStart = performance.now();
  const baseline = jobs.map(job => local(job));
  const rows: unknown[] = [{workers:0, totalMs:performance.now()-baselineStart}];
  try {
    for (const maxWorkers of [1,2,4]) {
      const timings: {queueMs:number;runMs:number;totalMs:number}[] = [];
      const pool = createPool<Tasks>({
        worker: () => new Worker(new URL('./worker.ts', import.meta.url), {type:'module'}),
        maxWorkers, maxQueue:16, onTask: t => timings.push(t),
      });
      try {
        const start = performance.now(); await pool.warmup();
        const startupMs = performance.now()-start;
        const before = frames;
        const begin = performance.now();
        const chunks = await pool.batch('generate', jobs, {chunkSize:2});
        const totalMs = performance.now()-begin;
        const equal = chunks.every((chunk,i)=>chunk.heights.every((h,j)=>h===baseline[i][j]));
        if (!equal) throw new Error('Worker output differs from the reference kernel');
        rows.push({workers:maxWorkers,startupMs,totalMs,uiFrames:frames-before,bytes:chunks.reduce((n,c)=>n+c.heights.byteLength,0),equal,stats:pool.stats});
        output.textContent = JSON.stringify(rows,null,2);
      } finally { await pool.close(); }
    }
    (window as any).__result = rows;
    return rows;
  } catch (error) { output.textContent=String(error); throw error; }
  finally { button.disabled=false; }
}
button.addEventListener('click',()=>{void run().catch(console.error);});
(window as any).__run = run;
output.textContent = 'Compare the same procedural kernel on the main thread and 1/2/4 workers. Each worker imports code and caches its generator; results transfer ownership.';
