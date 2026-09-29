import type { PoolConfig, WorkerPool } from './types.js';
import { createPool, type PoolHooks } from './pool.js';

export const createBrowserPool = (script: string, config?: PoolConfig): WorkerPool => {
  const urls = new Map<unknown, string>();
  const hooks: PoolHooks = {
    createWorker(source) {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try { const worker = new Worker(url); urls.set(worker, url); return worker; }
      catch (e) { URL.revokeObjectURL(url); throw e; }
    },
    postMessage(worker, data, transfer) { (worker as Worker).postMessage(data, transfer); },
    terminateWorker(worker) {
      (worker as Worker).terminate(); const url = urls.get(worker);
      if (url) URL.revokeObjectURL(url); urls.delete(worker);
    },
    onMessage(worker, handler) { (worker as Worker).onmessage = e => handler(e.data); },
    onError(worker, handler) {
      (worker as Worker).onerror = e => { e.preventDefault(); handler(new Error(e.message)); };
      (worker as Worker).onmessageerror = () => handler(new Error('Worker message could not be decoded'));
    },
  };
  return createPool(script, config ?? {}, hooks);
};
