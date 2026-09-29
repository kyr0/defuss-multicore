import { Worker } from 'node:worker_threads';
import { createPool } from 'defuss-multicore';
import { makeJobs } from '../shared/chunks.mjs';
const pool = createPool({ worker: () => new Worker(new URL('./worker.mjs', import.meta.url)), maxWorkers: 2 });
try {
  const chunks = await pool.batch('generate', makeJobs(8), { chunkSize: 2 });
  console.log({chunks:chunks.length, samples:chunks.reduce((n,c)=>n+c.heights.length,0), stats:pool.stats});
} finally { await pool.close(); }
