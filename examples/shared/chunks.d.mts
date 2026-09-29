export interface ChunkJob { cx: number; cy: number; seed: number; size?: number; octaves?: number }
export function createGenerator(seed: number): (job: Omit<ChunkJob, 'seed'>) => Float32Array<ArrayBuffer>;
export function makeJobs(count?: number, seed?: number): ChunkJob[];
