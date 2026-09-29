import type { TransferItem } from './types.js';
const moved = Symbol('defuss-multicore.transfer');
export interface Transferred<T> { readonly [moved]: true; readonly value: T; readonly transferList: readonly TransferItem[] }
/** Explicit worker-result ownership transfer. All listed objects must be reachable from value. */
export function transfer<T>(value: T, transferList: readonly TransferItem[]): Transferred<T> {
  for (const item of transferList) {
    if (typeof SharedArrayBuffer !== 'undefined' && item instanceof SharedArrayBuffer) throw new TypeError('SharedArrayBuffer is shared, never transferred');
  }
  return { [moved]: true, value, transferList: [...new Set(transferList)] };
}
export function isTransferred(value: unknown): value is Transferred<unknown> {
  return !!value && typeof value === 'object' && moved in value;
}
export type TaskResult<T> = Awaited<T> extends Transferred<infer V> ? V : Awaited<T>;
