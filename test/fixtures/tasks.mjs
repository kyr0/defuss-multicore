import { expose, transfer } from '../../dist/worker.mjs';
import { workerData } from 'node:worker_threads';
let calls = 0;
await expose({
  echo: value => value,
  add: ({ a, b }) => a + b,
  counter: () => ++calls,
  sleep: async ({ ms, value }) => { await new Promise(resolve => setTimeout(resolve, ms)); return value; },
  fail: () => { throw new RangeError('intentional'); },
  crash: () => process.exit(7),
  uncloneable: () => () => 1,
  bytes: values => { const bytes = Uint8Array.from(values); return transfer({ bytes }, [bytes.buffer]); },
  alias: () => { const a = new Uint8Array([1, 2, 3]); return transfer({ a, b: a.subarray(1) }, [a.buffer, a.buffer]); },
  double: bytes => { for (let i=0;i<bytes.length;i++) bytes[i] *= 2; return transfer(bytes, [bytes.buffer]); },
}, { init: async () => {
  if (workerData?.delay) await new Promise(resolve => setTimeout(resolve, workerData.delay));
  if (workerData?.fail) throw new Error('initialization failed');
} });
