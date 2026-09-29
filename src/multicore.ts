import type { MulticoreOptions, CallOptions, ParallelResult, WorkerPool } from './types.js';
import { isCallOptions, isTypedArray } from './types.js';
import { serializeFunction } from './serialize.js';
import { partitionArgs, shouldFallback, detectTransferables, getCoreCount } from './partition.js';
import { abortError, positiveInteger } from './pool.js';

type Fn = (...args: any[]) => any;
export interface MulticoreFunction<T extends Fn, V = Awaited<ReturnType<T>>[]> {
  (...args: [...Parameters<T>, CallOptions?]): ParallelResult<Awaited<ReturnType<T>>, V>;
  /** Unambiguous options for optional/default/rest parameters and arbitrary payloads. */
  withOptions(options: CallOptions, ...args: Parameters<T>): ParallelResult<Awaited<ReturnType<T>>, V>;
  warmup(): Promise<void>;
  close(): Promise<void>;
  terminate(): Promise<void>;
}
let factoryPromise: Promise<(script: string, config: any) => WorkerPool> | undefined;
function factory() {
  return factoryPromise ??= (async () => {
    if (typeof globalThis.Worker === 'function') return (await import('./pool-browser.js')).createBrowserPool;
    const [{ createNodePool }, { Worker }] = await Promise.all([import('./pool-node.js'), import('node:worker_threads')]);
    return (script: string, config: any) => createNodePool(script, Worker, config);
  })().catch(error => { factoryPromise = undefined; throw error; });
}
export function multicore<T extends Fn>(fn: T, options: MulticoreOptions<Awaited<ReturnType<T>>> & { reduce: (a: Awaited<ReturnType<T>>, b: Awaited<ReturnType<T>>) => Awaited<ReturnType<T>> }): MulticoreFunction<T, Awaited<ReturnType<T>>>;
export function multicore<T extends Fn>(fn: T, options?: MulticoreOptions<Awaited<ReturnType<T>>>): MulticoreFunction<T>;
export function multicore<T extends Fn>(fn: T, options?: MulticoreOptions<any>): any {
  const cores = positiveInteger(options?.cores ?? getCoreCount(), 'cores');
  const threshold = options?.threshold ?? 1024;
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new RangeError('threshold must be a nonnegative safe integer');
  const script = serializeFunction(fn);
  let poolPromise: Promise<WorkerPool> | undefined;
  let closed = false;
  // Cache the promise before awaiting the platform import: exactly one pool per wrapper.
  const getPool = () => poolPromise ??= factory().then(create => create(script, { maxWorkers: cores }));
  function invoke(args: any[], call: CallOptions = {}) {
    let promises: Promise<any>[];
    try {
      if (closed) throw new Error('Pool is closed');
      if (call.signal?.aborted) throw abortError();
      const count = positiveInteger(call.cores ?? cores, 'cores');
      const lengths = args.filter(a => Array.isArray(a) || isTypedArray(a)).map(a => a.length);
      const largest = Math.max(0, ...lengths);
      if (!largest || shouldFallback(args, threshold)) {
        promises = [Promise.resolve().then(() => {
          if (call.signal?.aborted) throw abortError();
          return fn(...args);
        })];
      } else {
        const chunks = partitionArgs(args, Math.min(count, largest));
        promises = chunks.map(workerArgs => {
          // Only move the independently owned TypedArray partitions. Broadcast inputs are cloned.
          const owned = workerArgs.filter((_, i) => isTypedArray(args[i]));
          const transfer = call.transfer === false ? [] : detectTransferables(owned);
          return getPool().then(pool => pool.execute(workerArgs, transfer, call.signal));
        });
      }
    } catch (error) { promises = [Promise.reject(error)]; }
    const collected = Promise.all(promises).then(values => options?.reduce && values.length ? values.reduce(options.reduce) : values);
    // Streaming-only consumers must not produce unhandled aggregate rejections.
    void collected.catch(() => undefined);
    return { then: collected.then.bind(collected), async *[Symbol.asyncIterator]() { for (const p of promises) yield await p; } };
  }
  const parallel = (...raw: any[]) => {
    // A required payload cannot be consumed as options. Use withOptions for ambiguous arities.
    const opts = raw.length > fn.length && isCallOptions(raw.at(-1)) ? raw.pop() : undefined;
    return invoke(raw, opts);
  };
  parallel.withOptions = (opts: CallOptions, ...args: any[]) => invoke(args, opts);
  parallel.warmup = () => closed ? Promise.reject(new Error('Pool is closed')) : getPool().then(p => p.warmup());
  parallel.close = async () => { closed = true; if (poolPromise) await (await poolPromise).close(); };
  parallel.terminate = async () => { closed = true; if (poolPromise) await (await poolPromise).terminate(); };
  if (options?.eager) void parallel.warmup().catch(() => undefined); // Work calls still receive initialization errors.
  return parallel;
}
export { getCoreCount as getPoolSize } from './partition.js';
