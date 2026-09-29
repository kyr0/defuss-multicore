import { transfer } from 'defuss-multicore/worker';
import { createGenerator } from './chunks.mjs';
// One seed cache per worker. Reconstructed after cancellation or idle eviction.
let seed, generator;
export const tasks = {
  generate(job) {
    if (!generator || seed !== job.seed) { seed = job.seed; generator = createGenerator(seed); }
    const heights = generator(job);
    return transfer({ cx: job.cx, cy: job.cy, heights }, [heights.buffer]);
  },
  async echo(value) { return value; },
};
