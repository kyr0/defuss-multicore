import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createPool, type TaskPool } from './task-pool.js';
import { multicore } from './multicore.js';
import { reduce, map, releaseArrayWorkers } from './parallel-array.js';
import type { Transferred } from './transfer.js';

type Tasks = {
  echo: (v: any) => any; add: (v: { a: number; b: number }) => number;
  counter: (v: null) => number; sleep: (v: { ms: number; value: number }) => Promise<number>;
  fail: (v: null) => never; crash: (v: null) => never; uncloneable: (v: null) => Function;
  bytes: (v: number[]) => Transferred<{ bytes: Uint8Array }>;
  alias: (v: null) => Transferred<{ a: Uint8Array; b: Uint8Array }>;
  double: (v: Uint8Array) => Transferred<Uint8Array>;
};
const url = new URL('../test/fixtures/tasks.mjs', import.meta.url);
const make = (extra: Record<string, any> = {}) => createPool<Tasks>({ worker: () => new Worker(url), maxWorkers: 2, ...extra });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function using(fn: (pool: TaskPool<Tasks>) => Promise<void>, extra = {}) {
  const p = make(extra); try { await fn(p); } finally { await p.terminate(); }
}

describe('module task pool: real Node workers', () => {
  it('bounds concurrent cold starts and reuses initialized workers', async () => {
    let created = 0;
    await using(async p => {
      expect(await Promise.all(Array.from({ length: 20 }, (_, i) => p.run('add', { a: i, b: 1 })))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(created).toBe(2); expect(p.stats.workers).toBe(2);
      expect(p.stats.completed).toBe(20);
    }, { worker: () => { created++; return new Worker(url, { workerData: { delay: 10 } }); } });
  });
  it('initializes before dispatch and preserves worker-local state', async () => {
    await using(async p => {
      await p.warmup();
      expect(await p.run('counter', null)).toBe(1);
      expect(await p.run('counter', null)).toBe(2);
    }, { maxWorkers: 1 });
  });
  it('accepts arbitrary options-shaped payloads and async results', async () => using(async p => {
    const value = { cores: 4, signal: 'business data', transfer: 'data' };
    expect(await p.run('echo', value)).toEqual(value);
    expect(await p.run('sleep', { ms: 2, value: 8 })).toBe(8);
  }));
  it('moves nested results, deduplicates aliases, and detaches explicit input transfers', async () => using(async p => {
    expect(Array.from((await p.run('bytes', [1,2])).bytes)).toEqual([1,2]);
    const aliases = await p.run('alias', null);
    expect(aliases.a.buffer).toBe(aliases.b.buffer);
    const bytes = new Uint8Array([3,4]);
    const result = await p.run('double', bytes, { transfer: [bytes.buffer] });
    expect(bytes.byteLength).toBe(0); expect(Array.from(result)).toEqual([6,8]);
    const retained = new Uint8Array([5]);
    await p.run('double', retained); expect(retained[0]).toBe(5);
  }));
  it('drains queued work after active abort and immediately removes queued aborts', async () => using(async p => {
    await p.warmup();
    const c = new AbortController();
    const active = p.run('sleep', { ms: 1000, value: 1 }, { signal: c.signal }).catch(e => e.name);
    const queued = p.run('add', { a: 2, b: 3 });
    c.abort(); expect(await active).toBe('AbortError'); expect(await queued).toBe(5);
    const busy = p.run('sleep', { ms: 40, value: 2 });
    const q = new AbortController();
    const cancelled = p.run('counter', null, { signal: q.signal }).catch(e => e.name);
    q.abort(); expect(await cancelled).toBe('AbortError'); expect(p.stats.queued).toBe(0); await busy;
  }, { maxWorkers: 1 }));
  it('isolates crashes from active peers and recovers capacity', async () => using(async p => {
    await p.warmup();
    const dying = p.run('crash', null).catch(e => e.message);
    const survivor = p.run('sleep', { ms: 20, value: 9 });
    expect(await dying).toMatch(/exited/); expect(await survivor).toBe(9);
    expect(await p.run('add', { a: 3, b: 4 })).toBe(7);
  }));
  it('rejects input/result cloning failures without losing slots', async () => using(async p => {
    await expect(p.run('echo', () => 1)).rejects.toThrow();
    await expect(p.run('uncloneable', null)).rejects.toThrow();
    await expect(p.run('fail', null)).rejects.toMatchObject({ name: 'RangeError', message: 'intentional' });
    expect(await p.run('add', { a: 1, b: 1 })).toBe(2);
  }, { maxWorkers: 1 }));
  it('bounds the queue and expires queued/running tasks', async () => using(async p => {
    await p.warmup();
    const first = p.run('sleep', { ms: 1000, value: 1 }, { timeoutMs: 80 }).catch(e => e.name);
    const second = p.run('counter', null, { timeoutMs: 5 }).catch(e => e.name);
    await expect(p.run('counter', null)).rejects.toMatchObject({ name: 'QueueFullError' });
    expect(await second).toBe('TimeoutError'); expect(await first).toBe('TimeoutError');
    expect(await p.run('counter', null)).toBe(1);
  }, { maxWorkers: 1, maxQueue: 1 }));
  it('uses stable priority for waiting work', async () => using(async p => {
    await p.warmup();
    const busy = p.run('sleep', { ms: 50, value: 0 });
    const order: string[] = [];
    const a = p.run('counter', null).then(() => order.push('a'));
    const b = p.run('counter', null, { priority: 2 }).then(() => order.push('b'));
    const c = p.run('counter', null, { priority: 2 }).then(() => order.push('c'));
    await Promise.all([busy,a,b,c]); expect(order).toEqual(['b','c','a']);
  }, { maxWorkers: 1 }));
  it('batches thousands of jobs with bounded outstanding chunks and ordered output', async () => using(async p => {
    const jobs = Array.from({ length: 1003 }, (_, i) => ({ a: i, b: 2 }));
    const results = await p.batch('add', jobs, { chunkSize: 17 });
    expect(results).toEqual(jobs.map(x => x.a+x.b));
    expect(p.stats.completed).toBe(Math.ceil(1003/17));
  }, { maxQueue: 0 }));
  it('streams completed chunks with indices; early return cancels only its work', async () => using(async p => {
    await p.warmup();
    const seen = [];
    for await (const r of p.stream('sleep', [{ ms: 80, value: 0 }, { ms: 1, value: 1 }, { ms: 1, value: 2 }])) seen.push(r);
    expect(seen[0]).toEqual({index:1,value:1}); expect(seen.map(r=>r.index).sort()).toEqual([0,1,2]);
    for await (const r of p.stream('sleep', [{ms:1,value:3},{ms:1000,value:4}])) { expect(r.value).toBe(3); break; }
    expect(p.stats.active).toBe(0);
    expect(await p.run('add', {a:1,b:2})).toBe(3);
  }));
  it('propagates batch failures and cleans up siblings', async () => using(async p => {
    await expect(p.batch('fail', [null,null,null])).rejects.toThrow('intentional');
    expect(p.stats.active).toBe(0); expect(p.stats.queued).toBe(0);
  }));
  it('drains close, rejects new work, and makes termination idempotent', async () => {
    const p = make({maxWorkers:1});
    const a = p.run('sleep', {ms:5,value:1}), b = p.run('counter',null);
    const close = p.close(); await expect(p.run('counter',null)).rejects.toThrow('closed');
    expect(await a).toBe(1); expect(await b).toBe(1); await close;
    expect(p.stats.workers).toBe(0); await p.close(); await p.terminate();
  });
  it('rejects initialization failure and startup timeout without restart loops', async () => {
    await using(async p => {
      await expect(p.run('counter',null)).rejects.toThrow('initialization failed');
      expect(p.stats.workers).toBe(0);
    }, {maxWorkers:1,worker:()=>new Worker(url,{workerData:{fail:true}})});
    await using(async p => {
      await expect(p.run('counter',null)).rejects.toThrow('timed out');
    }, {maxWorkers:1,startupTimeoutMs:10,worker:()=>new Worker(url,{workerData:{delay:100}})});
  });
  it('evicts idle workers and reconstructs state on demand', async () => using(async p => {
    expect(await p.run('counter',null)).toBe(1); await delay(70);
    expect(p.stats.workers).toBe(0); expect(await p.run('counter',null)).toBe(1);
  }, {maxWorkers:1,idleTimeoutMs:10}));
});

describe('legacy correctness regressions', () => {
  it('awaits async handlers on fallback and worker paths', async () => {
    const f = multicore(async (items:number[]) => items.reduce((a,b)=>a+b,0),{cores:2,threshold:2});
    try { expect(await f([3])).toEqual([3]); expect(await f([1,2,3,4])).toEqual([3,7]); } finally { await f.terminate(); }
  });
  it('keeps required options-shaped payloads and offers explicit options for default arguments', async () => {
    const f = multicore((items:number[], payload:{cores:number})=>payload.cores,{cores:2,threshold:2});
    const g = multicore((items:number[], payload={cores:1})=>payload.cores,{cores:2,threshold:2});
    try { expect(await f([1],{cores:7})).toEqual([7]); expect(await f([1,2],{cores:7})).toEqual([7,7]);
      expect(await g.withOptions({cores:1},[1,2],{cores:9})).toEqual([9]);
    } finally { await f.terminate(); await g.terminate(); }
  });
  it('transfers compact partitions without detaching caller buffers or broadcast buffers', async () => {
    const f=multicore((items:Float32Array,extra:ArrayBuffer)=>[items.byteLength,items.buffer.byteLength,extra.byteLength],{cores:4,threshold:1});
    const input=new Float32Array(4096), extra=new ArrayBuffer(8);
    try { expect(await f(input,extra)).toEqual(Array.from({length:4},()=>[4096,4096,8]));
      expect(input.byteLength).toBe(16384); expect(extra.byteLength).toBe(8);
    } finally {await f.terminate();}
  });
  it('supports empty reduction, nested aliased result buffers, and callback-pool disposal', async () => {
    expect(await reduce<number>([],(a,b)=>a+b,5)).toBe(5);
    const f=multicore((items:number[])=>{const a=new Uint8Array(items);return {a,b:a.subarray(1)};},{cores:2,threshold:1});
    try {const r=await f([1,2,3,4]);expect(r[0].a.buffer).toBe(r[0].b.buffer);}finally{await f.terminate();}
    const twice=(v:number)=>v*2;
    expect(await map([1,2],twice)).toEqual([2,4]); await releaseArrayWorkers(twice);
  });
});

it('preserves actual completion order while a stream consumer is paused', async () => using(async p => {
  await p.warmup();
  const iterator = p.stream('sleep', [{ms:1,value:0},{ms:80,value:1},{ms:20,value:2}])[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({index:0,value:0});
  await delay(120);
  expect((await iterator.next()).value).toEqual({index:2,value:2});
  expect((await iterator.next()).value).toEqual({index:1,value:1});
  await iterator.return?.();
}, {maxWorkers:3}));

it('legacy cold/eager initialization uses exactly one real worker pool', async () => {
  for (const eager of [false,true]) {
    // Preserve native import(): Vitest rewrites imports in ordinary callbacks,
    // and those runner-internal helpers cannot be serialized into a worker.
    const identity = new Function('return async (_chunk) => (await import("node:worker_threads")).threadId')() as (chunk: number[]) => Promise<number>;
    const f=multicore(identity,{cores:4,threshold:1,eager});
    try { const ids=[...await f([1,2,3,4]),...await f([1,2,3,4])]; expect(new Set(ids).size).toBe(4); }
    finally { await f.terminate(); }
  }
});
