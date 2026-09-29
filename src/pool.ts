import type { PoolConfig, WorkerPool, TransferItem, ExecutionOptions, PoolStats } from './types.js';
import { getCoreCount } from './partition.js';

export interface PoolHooks {
  createWorker(script: string, id: number): unknown;
  postMessage(worker: unknown, data: unknown, transfer: any[]): void;
  terminateWorker(worker: unknown): void | Promise<unknown>;
  onMessage(worker: unknown, handler: (data: any) => void): void;
  onError(worker: unknown, handler: (error: unknown) => void): void;
}

export const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}
const namedError = (name: string, message: string) => Object.assign(new Error(message), { name });

interface Job {
  id: string; args: unknown[]; transfer: TransferItem[]; priority: number;
  resolve(value: unknown): void; reject(error: unknown): void;
  submitted: number; started?: number; done: boolean;
  signal?: AbortSignal; abort?: () => void; timer?: ReturnType<typeof setTimeout>;
}
interface Slot {
  raw: unknown; ready: boolean; retired: boolean; job?: Job;
  idle?: ReturnType<typeof setTimeout>; startup?: ReturnType<typeof setTimeout>;
  readiness: Promise<void>; readyResolve(): void; readyReject(error: unknown): void;
}

/** One scheduler for serialized functions and module task workers. No automatic replay. */
export function createPool(script: string, config: PoolConfig, hooks: PoolHooks): WorkerPool {
  const maxWorkers = positiveInteger(config.maxWorkers ?? getCoreCount(), 'maxWorkers');
  const maxQueue = config.maxQueue ?? Infinity;
  if (maxQueue !== Infinity && (!Number.isSafeInteger(maxQueue) || maxQueue < 0)) throw new RangeError('maxQueue must be a nonnegative integer or Infinity');
  const idleTimeout = config.idleTimeoutMs ?? 30_000;
  const startupTimeout = config.startupTimeoutMs ?? 10_000;
  for (const [name, n] of [['idleTimeoutMs', idleTimeout], ['startupTimeoutMs', startupTimeout]] as const) {
    if (n !== Infinity && (!Number.isFinite(n) || n < 0 || n > 2_147_483_647)) throw new RangeError(`${name} must be 0..2147483647 or Infinity`);
  }
  const workers = new Set<Slot>();
  const jobs = new Set<Job>();
  const queue: Job[] = [];
  const stops = new Set<Promise<unknown>>();
  let state: 'open' | 'closing' | 'closed' = 'open';
  let nextId = 0, workerId = 0, draining = false;
  let closePromise: Promise<void> | undefined;
  let closeResolve: (() => void) | undefined;
  const counters = { completed: 0, failed: 0, cancelled: 0 };

  function stop(slot: Slot, reason = new Error('Worker stopped')) {
    if (slot.retired) return;
    slot.retired = true;
    workers.delete(slot);
    clearTimeout(slot.idle); clearTimeout(slot.startup);
    if (!slot.ready) slot.readyReject(reason);
    const p = Promise.resolve().then(() => hooks.terminateWorker(slot.raw)).catch(() => undefined);
    stops.add(p);
    void p.then(() => stops.delete(p));
  }
  function settle(job: Job, status: 'completed' | 'failed' | 'cancelled', value: unknown) {
    if (job.done) return;
    job.done = true; jobs.delete(job);
    const at = queue.indexOf(job);
    if (at >= 0) queue.splice(at, 1);
    clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
    counters[status]++;
    const now = performance.now();
    try { config.onTask?.({ id: job.id, status, queueMs: (job.started ?? now) - job.submitted,
      runMs: job.started === undefined ? 0 : now - job.started, totalMs: now - job.submitted }); } catch { /* Observers cannot corrupt the scheduler. */ }
    if (status === 'completed') job.resolve(value); else job.reject(value);
  }
  function idle(slot: Slot) {
    clearTimeout(slot.idle);
    if (slot.retired || !slot.ready || slot.job || idleTimeout === Infinity) return;
    slot.idle = setTimeout(() => { if (!slot.job) stop(slot); }, idleTimeout);
    slot.idle.unref?.();
  }
  function finishClose() {
    if (state !== 'closing' || jobs.size) return;
    state = 'closed';
    for (const slot of workers) stop(slot);
    void Promise.all([...stops]).then(() => closeResolve?.());
  }
  function cancel(job: Job, error: Error) {
    if (job.done) return;
    for (const slot of workers) if (slot.job === job) { slot.job = undefined; stop(slot, error); break; }
    settle(job, 'cancelled', error); drain();
  }
  function failed(slot: Slot, error: unknown) {
    if (slot.retired) return;
    const e = error instanceof Error ? error : new Error(String(error));
    const startup = !slot.ready;
    const job = slot.job; slot.job = undefined;
    stop(slot, e);
    if (job) settle(job, 'failed', e);
    // Failed initialization must not spawn an infinite restart loop. Active peers survive.
    if (startup) for (const pending of [...queue]) settle(pending, 'failed', e);
    drain();
  }
  function receive(slot: Slot, data: any) {
    if (slot.retired || !data) return;
    if (data.type === 'ready' && !slot.ready) {
      slot.ready = true; clearTimeout(slot.startup); slot.readyResolve(); idle(slot); drain(); return;
    }
    if (data.type === 'init-error') { failed(slot, new Error(data.error)); return; }
    const job = slot.job;
    if (!job || data.id !== job.id || (data.type !== 'result' && data.type !== 'error')) return;
    slot.job = undefined;
    if (data.type === 'result') settle(job, 'completed', data.value);
    else {
      const error = namedError(data.name ?? 'Error', data.error);
      if (data.stack) error.stack = data.stack;
      settle(job, 'failed', error);
    }
    idle(slot); drain();
  }
  function spawn(): Slot {
    const raw = hooks.createWorker(script, workerId++);
    let resolve!: () => void, reject!: (e: unknown) => void;
    const readiness = new Promise<void>((a, b) => { resolve = a; reject = b; });
    void readiness.catch(() => undefined);
    const slot: Slot = { raw, ready: !config.waitForReady, retired: false, readiness, readyResolve: resolve, readyReject: reject };
    workers.add(slot);
    try {
      hooks.onMessage(raw, data => receive(slot, data));
      hooks.onError(raw, error => failed(slot, error));
      if (slot.ready) { resolve(); idle(slot); }
      else if (startupTimeout !== Infinity) slot.startup = setTimeout(() => failed(slot, namedError('WorkerStartupError', 'Worker initialization timed out')), startupTimeout);
    } catch (error) { stop(slot, error as Error); throw error; }
    return slot;
  }
  function dispatch(slot: Slot, job: Job) {
    slot.job = job; job.started = performance.now(); clearTimeout(slot.idle);
    try { hooks.postMessage(slot.raw, { type: 'execute', id: job.id, args: job.args }, job.transfer); }
    catch (error) { slot.job = undefined; settle(job, 'failed', error); idle(slot); }
  }
  function drain() {
    if (draining || state === 'closed') return;
    draining = true;
    try {
      while (queue.length) {
        let slot = [...workers].find(w => w.ready && !w.job && !w.retired);
        if (!slot) {
          if (workers.size >= maxWorkers) break;
          try { slot = spawn(); } catch (error) { settle(queue[0], 'failed', error); continue; }
          if (!slot.ready) continue;
        }
        const job = queue.shift()!;
        if (!job.done) dispatch(slot, job);
      }
    } finally { draining = false; finishClose(); }
  }
  function beginClose() {
    closePromise ??= new Promise<void>(resolve => { closeResolve = resolve; });
    if (state === 'open') state = 'closing';
    return closePromise;
  }

  return {
    get size() { return maxWorkers; },
    get stats(): PoolStats { return { workers: workers.size, ready: [...workers].filter(w => w.ready).length,
      active: [...workers].filter(w => w.job).length, queued: queue.length, state, ...counters }; },
    execute(args, transfer = [], signal, options: ExecutionOptions = {}) {
      if (state !== 'open') return Promise.reject(namedError('PoolClosedError', 'Pool is closed'));
      if (signal?.aborted) return Promise.reject(abortError());
      if (!Number.isFinite(options.priority ?? 0)) return Promise.reject(new RangeError('priority must be finite'));
      const timeout = options.timeoutMs;
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647)) return Promise.reject(new RangeError('timeoutMs must be 0..2147483647'));
      // Starting workers have one admission slot each, even before the ready handshake.
      const immediate = [...workers].filter(w => !w.job).length + maxWorkers - workers.size;
      if (queue.length >= maxQueue + immediate) return Promise.reject(namedError('QueueFullError', 'Worker queue is full'));
      return new Promise((resolve, reject) => {
        const job: Job = { id: `t${nextId++}`, args, transfer: [...new Set(transfer)], priority: options.priority ?? 0,
          resolve, reject, submitted: performance.now(), done: false, signal };
        jobs.add(job);
        let at = queue.findIndex(q => q.priority < job.priority);
        if (at < 0) at = queue.length;
        queue.splice(at, 0, job);
        if (signal) { job.abort = () => cancel(job, abortError()); signal.addEventListener('abort', job.abort, { once: true }); }
        if (timeout !== undefined) job.timer = setTimeout(() => cancel(job, namedError('TimeoutError', 'Task timed out')), timeout);
        drain();
      });
    },
    warmup(count = maxWorkers) {
      if (state !== 'open') return Promise.reject(namedError('PoolClosedError', 'Pool is closed'));
      positiveInteger(count, 'count');
      try { while (workers.size < Math.min(count, maxWorkers)) spawn(); }
      catch (e) { return Promise.reject(e); }
      return Promise.all([...workers].map(w => w.readiness)).then(() => undefined);
    },
    close() { const p = beginClose(); finishClose(); return p; },
    terminate() {
      if (state === 'closed') return closePromise ?? Promise.resolve();
      const p = beginClose();
      for (const job of [...jobs]) settle(job, 'cancelled', new Error('Pool terminated'));
      for (const slot of workers) { slot.job = undefined; stop(slot); }
      finishClose(); return p;
    },
  };
}
