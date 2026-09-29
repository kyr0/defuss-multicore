import type { Worker as NodeWorker } from 'node:worker_threads';
import type { TaskHandlers } from './worker.js';
import type { TaskResult } from './transfer.js';
import type { TransferItem, ExecutionOptions, TaskTiming, PoolStats } from './types.js';
import { createPool as createScheduler, positiveInteger } from './pool.js';
import { getCoreCount } from './partition.js';

export interface TaskPoolOptions {
  worker: () => Worker | NodeWorker;
  maxWorkers?: number;
  /** Waiting jobs beyond available worker slots. Default 128; overflow rejects. */
  maxQueue?: number;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
  onTask?: (timing: TaskTiming) => void;
}
export interface RunOptions extends ExecutionOptions {
  signal?: AbortSignal;
  transfer?: readonly TransferItem[];
}
export interface BatchOptions<I> extends ExecutionOptions {
  signal?: AbortSignal;
  chunkSize?: number;
  /** Maximum outstanding chunks for this batch. Default pool size. */
  concurrency?: number;
  transfer?: (payload: I, index: number) => readonly TransferItem[];
}
type Name<T> = Extract<keyof T, string>;
type Input<T extends TaskHandlers, K extends Name<T>> = Parameters<T[K]>[0];
type Output<T extends TaskHandlers, K extends Name<T>> = TaskResult<ReturnType<T[K]>>;
export interface TaskPool<T extends TaskHandlers> {
  readonly size: number;
  readonly stats: PoolStats;
  run<K extends Name<T>>(task: K, payload: Input<T, K>, options?: RunOptions): Promise<Output<T, K>>;
  batch<K extends Name<T>>(task: K, jobs: readonly Input<T, K>[], options?: BatchOptions<Input<T, K>>): Promise<Output<T, K>[]>;
  /** Completion order across chunks, input order within a chunk; original indices accompany values. */
  stream<K extends Name<T>>(task: K, jobs: readonly Input<T, K>[], options?: BatchOptions<Input<T, K>>): AsyncIterable<{ index: number; value: Output<T, K> }>;
  warmup(count?: number): Promise<void>;
  close(): Promise<void>;
  terminate(): Promise<void>;
}

/** A reusable bounded pool. run() never silently falls back to the calling thread. */
export function createPool<T extends TaskHandlers>(options: TaskPoolOptions): TaskPool<T> {
  const maxWorkers = options.maxWorkers ?? Math.max(1, Math.min(4, getCoreCount() - 1));
  const cleanups = new Map<unknown, () => void>();
  const pool = createScheduler('', { ...options, maxWorkers, maxQueue: options.maxQueue ?? 128, waitForReady: true }, {
    createWorker: () => options.worker(),
    postMessage(worker, data, transfer) { (worker as any).postMessage(data, transfer); },
    terminateWorker(worker) {
      const cleanup = () => { cleanups.get(worker)?.(); cleanups.delete(worker); };
      try { return Promise.resolve((worker as any).terminate()).finally(cleanup); }
      catch (error) { cleanup(); throw error; }
    },
    onMessage(worker, handler) {
      const w = worker as any;
      if (typeof w.on === 'function') {
        w.on('message', handler); cleanups.set(w, () => w.off('message', handler));
      } else {
        const listener = (e: MessageEvent) => handler(e.data);
        w.addEventListener('message', listener); cleanups.set(w, () => w.removeEventListener('message', listener));
      }
    },
    onError(worker, handler) {
      const w = worker as any, previous = cleanups.get(w);
      if (typeof w.on === 'function') {
        const exit = (code: number) => handler(new Error(`Worker exited (${code})`));
        w.on('error', handler); w.on('messageerror', handler); w.on('exit', exit);
        cleanups.set(w, () => { previous?.(); w.off('error', handler); w.off('messageerror', handler); w.off('exit', exit); });
      } else {
        const error = (e: ErrorEvent) => { e.preventDefault(); handler(new Error(e.message)); };
        const messageError = () => handler(new Error('Worker message could not be decoded'));
        w.addEventListener('error', error); w.addEventListener('messageerror', messageError);
        cleanups.set(w, () => { previous?.(); w.removeEventListener('error', error); w.removeEventListener('messageerror', messageError); });
      }
    },
  });

  async function* stream(name: string, inputs: readonly unknown[], opts: BatchOptions<unknown> = {}): AsyncGenerator<{ index: number; value: unknown }> {
    const chunkSize = positiveInteger(opts.chunkSize ?? 1, 'chunkSize');
    const concurrency = positiveInteger(opts.concurrency ?? maxWorkers, 'concurrency');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    type Completion = { start: number; values: unknown[]; error?: undefined } | { start: number; error: unknown; values?: undefined };
    const pending = new Map<number, Promise<Completion>>();
    const completed: Completion[] = [];
    let wake: (() => void) | undefined;
    let next = 0;
    const submit = () => {
      while (next < inputs.length && pending.size < concurrency && !controller.signal.aborted) {
        const start = next; next = Math.min(inputs.length, next + chunkSize);
        const chunk = inputs.slice(start, next);
        const transfers = opts.transfer ? chunk.flatMap((x, i) => [...opts.transfer!(x, start + i)]) : [];
        // Resolve failures as records: a paused consumer never causes unhandled rejections.
        pending.set(start, pool.execute([name, chunk, true], transfers, controller.signal, opts).then(
          values => ({ start, values: values as unknown[] }), error => ({ start, error })).then(result => {
            completed.push(result); wake?.(); wake = undefined; return result;
          }));
      }
    };
    try {
      if (controller.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      submit();
      while (pending.size) {
        if (!completed.length) await new Promise<void>(resolve => { wake = resolve; });
        const result = completed.shift()!;
        pending.delete(result.start);
        if ('error' in result) throw result.error;
        for (let i = 0; i < result.values!.length; i++) yield { index: result.start + i, value: result.values![i] };
        if (controller.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        submit();
      }
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      controller.abort(); // Early iterator return cancels this stream's outstanding chunks only.
      await Promise.all(pending.values());
    }
  }
  return {
    get size() { return pool.size; }, get stats() { return pool.stats; },
    run: (name, payload, opts = {}) => pool.execute([name, payload], [...(opts.transfer ?? [])], opts.signal, opts) as any,
    stream: stream as any,
    async batch(name, inputs, opts) {
      const results: any[] = new Array(inputs.length);
      for await (const { index, value } of stream(name, inputs, opts as BatchOptions<unknown>)) results[index] = value;
      return results;
    },
    warmup: count => pool.warmup(count), close: () => pool.close(), terminate: () => pool.terminate(),
  };
}
