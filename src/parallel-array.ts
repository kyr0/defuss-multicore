import type { CallOptions, ParallelResult } from './types.js';
import { multicore, type MulticoreFunction } from './multicore.js';

// Repeated calls with the same function/options reuse a pool. Weak keys permit function collection.
const caches = { map: new WeakMap<Function, Map<number | undefined, MulticoreFunction<any>>>(),
  filter: new WeakMap<Function, Map<number | undefined, MulticoreFunction<any>>>(),
  reduce: new WeakMap<Function, Map<number | undefined, MulticoreFunction<any>>>() };
function processor(kind: keyof typeof caches, fn: Function, cores?: number) {
  let configs = caches[kind].get(fn);
  if (!configs) caches[kind].set(fn, configs = new Map());
  let parallel = configs.get(cores);
  if (!parallel) {
    const body = kind === 'reduce' ? 'return chunk.reduce(callback)' : `return chunk.${kind}(callback)`;
    const chunk = new Function('chunk', `const callback = ${fn.toString()}; ${body};`) as (items: unknown[]) => unknown;
    parallel = multicore(chunk, { cores, threshold: 1024 }); configs.set(cores, parallel);
  }
  return parallel;
}
function flatten<T>(r: ParallelResult<T[]>): ParallelResult<T[], T[]> {
  const promise = Promise.resolve(r).then(chunks => chunks.flat());
  void promise.catch(() => undefined);
  return { then: promise.then.bind(promise), [Symbol.asyncIterator]: () => r[Symbol.asyncIterator]() };
}
/** Pure, synchronous, item-only callback; awaited output is flat, streaming output is chunked. */
export function map<T, U>(array: T[], fn: (item: T) => U, options?: CallOptions): ParallelResult<U[], U[]> {
  return flatten(processor('map', fn, options?.cores).withOptions(options ?? {}, array));
}
export function filter<T>(array: T[], fn: (item: T) => boolean, options?: CallOptions): ParallelResult<T[], T[]> {
  return flatten(processor('filter', fn, options?.cores).withOptions(options ?? {}, array));
}
/** Associative reducer only. initial is applied exactly once; regrouping may change floating-point rounding. */
export function reduce<T>(array: T[], fn: (a: T, b: T) => T, initial: T, options?: CallOptions): Promise<T> {
  if (options?.signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  if (!array.length) return Promise.resolve(initial);
  return Promise.resolve(processor('reduce', fn, options?.cores).withOptions(options ?? {}, array)).then(parts => parts.reduce(fn, initial));
}
/** Explicitly release pools cached for this callback (optionally one core configuration). */
export async function releaseArrayWorkers(fn: Function, cores?: number): Promise<void> {
  for (const cache of Object.values(caches)) {
    const configs = cache.get(fn);
    if (!configs) continue;
    for (const [key, pool] of configs) if (cores === undefined || key === cores) { await pool.close(); configs.delete(key); }
    if (!configs.size) cache.delete(fn);
  }
}
