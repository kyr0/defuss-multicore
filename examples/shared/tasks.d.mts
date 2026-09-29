import type { Transferred } from 'defuss-multicore';
import type { ChunkJob } from './chunks.mjs';
export const tasks: {
  generate(job: ChunkJob): Transferred<{cx:number;cy:number;heights:Float32Array<ArrayBuffer>}>;
  echo<T>(value: T): Promise<T>;
};
