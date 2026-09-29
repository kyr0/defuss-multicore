import { it, expect } from 'vitest';
import { createPool } from './task-pool.js';
import type { Tasks } from './test-worker.js';
import { multicore } from './multicore.js';

const make = (maxWorkers = 2) => createPool<Tasks>({worker:()=>new Worker(new URL('./test-worker.ts',import.meta.url),{type:'module'}),maxWorkers});
it('runs imported modules, async initialization, typed jobs and explicit transfers in browser workers', async () => {
  const p=make();
  try {
    await p.warmup();
    expect(await p.run('add',{a:3,b:4})).toBe(7);
    expect(await p.run('echo',{cores:4,transfer:'payload'})).toEqual({cores:4,transfer:'payload'});
    const bytes=new Uint8Array([3,4]); const result=await p.run('double',bytes,{transfer:[bytes.buffer]});
    expect(bytes.byteLength).toBe(0);expect(Array.from(result)).toEqual([6,8]);
    expect((await p.run('alias',null)).a.buffer.byteLength).toBe(3);
    const chunks=await p.batch('add',Array.from({length:40},(_,a)=>({a,b:2})),{chunkSize:3});
    expect(chunks).toEqual(Array.from({length:40},(_,a)=>a+2));
  } finally {await p.close();}
});
it('cancels active and queued browser work, recovers slots, and rejects clone failures', async()=>{
  const p=make(1);try{
    await p.warmup();const c=new AbortController();
    const a=p.run('sleep',{ms:1000,value:1},{signal:c.signal}).catch(e=>e.name);
    const b=p.run('add',{a:2,b:3});c.abort();expect(await a).toBe('AbortError');expect(await b).toBe(5);
    await expect(p.run('echo',()=>1)).rejects.toThrow();
    expect(await p.run('add',{a:2,b:2})).toBe(4);
  }finally{await p.terminate();}
});
it('streams browser completions with stable identities and releases abandoned work',async()=>{
  const p=make();try{
    await p.warmup();const out=[];
    for await(const value of p.stream('sleep',[{ms:100,value:0},{ms:1,value:1}]))out.push(value);
    expect(out[0].index).toBe(1);expect(out.map(x=>x.value).sort()).toEqual([0,1]);
    for await(const value of p.stream('sleep',[{ms:1,value:2},{ms:1000,value:3}])){expect(value.value).toBe(2);break;}
    expect(p.stats.active).toBe(0);
  }finally{await p.terminate();}
});
it('legacy async functions and nested aliased results work on browser and fallback paths',async()=>{
  const f=multicore(async(a:number[])=>{const data=new Uint8Array(a);return {data,alias:data.subarray(1)};},{cores:2,threshold:2});
  try{expect((await f([5]))[0].data[0]).toBe(5);const r=await f([1,2,3,4]);expect(r[0].data.buffer).toBe(r[0].alias.buffer);}finally{await f.terminate();}
});
