import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { createPool } from '../dist/index.mjs';
import { createGenerator, makeJobs } from '../examples/shared/chunks.mjs';
const jobs = makeJobs(Number(process.env.BENCH_JOBS ?? 64));
const generator = createGenerator(42);
const reference = jobs.map(job => generator(job));
const median = a => [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const rows = [];
for (const workers of [0,1,2,4]) {
  let created = 0;
  const samples = [], timings = [];
  const pool = workers ? createPool({worker:()=>{created++;return new Worker(new URL('../examples/node/worker.mjs',import.meta.url));},maxWorkers:workers,onTask:t=>timings.push(t)}) : null;
  try {
    const coldStart=performance.now(); await pool?.warmup(); const startupMs=performance.now()-coldStart;
    for(let run=0;run<6;run++) {
      const start=performance.now();
      const result=pool?await pool.batch('generate',jobs,{chunkSize:2}):jobs.map(job=>({heights:generator(job)}));
      const ms=performance.now()-start;
      if(!result.every((r,i)=>r.heights.every((v,j)=>v===reference[i][j])))throw Error('Output mismatch');
      if(run)samples.push(ms);
    }
    rows.push({workers,created,startupMs,medianMs:median(samples),samplesMs:samples,outputBytes:reference.reduce((n,a)=>n+a.byteLength,0),processRssBytes:process.memoryUsage().rss,queueMedianMs:timings.length?median(timings.map(t=>t.queueMs)):0});
  }finally{await pool?.close();}
}
const report={node:process.version,platform:process.platform,hardwareConcurrency:navigator.hardwareConcurrency,workload:{jobs:jobs.length,size:64,octaves:12,chunkSize:2},rows};
console.log(JSON.stringify(report,null,2));
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
