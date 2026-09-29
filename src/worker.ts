import { isTransferred } from './transfer.js';
import type { TransferItem } from './types.js';
export { transfer } from './transfer.js';
export type { Transferred, TaskResult } from './transfer.js';
export type TaskHandlers = Record<string, (payload: any) => any>;
export interface ExposeOptions { init?: () => void | PromiseLike<void> }

/** Register module-local handlers. init runs once; the ready handshake gates all dispatch. */
export async function expose<T extends TaskHandlers>(tasks: T, options: ExposeOptions = {}): Promise<void> {
  let send: (value: unknown, transfer?: TransferItem[]) => void;
  let listen: (handler: (data: any) => void) => void;
  if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof document === 'undefined') {
    const scope = self as any;
    send = (data, list = []) => scope.postMessage(data, list);
    listen = handler => scope.addEventListener('message', (event: MessageEvent) => handler(event.data));
  } else {
    const { parentPort } = await import('node:worker_threads');
    if (!parentPort) throw new Error('expose() must run inside a worker');
    send = (data, list = []) => parentPort.postMessage(data, list as any[]);
    listen = handler => parentPort.on('message', handler);
  }
  try { await options.init?.(); }
  catch (error) { send({ type: 'init-error', error: String(error) }); return; }
  listen(async data => {
    if (data?.type !== 'execute') return;
    try {
      const [name, payload, batch = false] = data.args;
      if (!Object.hasOwn(tasks, name) || typeof tasks[name] !== 'function') throw new Error(`Unknown worker task: ${String(name)}`);
      const transfers: TransferItem[] = [];
      const run = async (input: unknown) => {
        const result = await tasks[name](input);
        if (!isTransferred(result)) return result;
        transfers.push(...result.transferList); return result.value;
      };
      let value: unknown;
      if (batch) {
        if (!Array.isArray(payload)) throw new TypeError('Batch payload must be an array');
        const values = [];
        // Serial per worker: mutable local caches cannot race between batch items.
        for (const input of payload) values.push(await run(input));
        value = values;
      } else value = await run(payload);
      send({ type: 'result', id: data.id, value }, [...new Set(transfers)]);
    } catch (error) {
      send({ type: 'error', id: data.id, name: error instanceof Error ? error.name : 'Error',
        error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  });
  send({ type: 'ready' });
}
