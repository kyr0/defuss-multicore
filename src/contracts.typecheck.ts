// Compiled by typecheck; never imported at runtime.
import { createPool, multicore, map, filter } from './index.js';
import type { Transferred } from './transfer.js';
async function contracts() {
  const p=createPool<{sum:(v:{a:number;b:number})=>Promise<number>;bytes:(v:number)=>Transferred<Uint8Array>}>({worker:()=>new Worker('worker.js')});
  const n: number=await p.run('sum',{a:1,b:2});
  const b: Uint8Array=await p.run('bytes',3);
  const list: number[]=await p.batch('sum',[{a:1,b:2}]);
  // @ts-expect-error unknown task
  p.run('missing',1);
  // @ts-expect-error incorrect task payload
  p.run('sum',{a:'1',b:2});
  // @ts-expect-error an awaited numeric result is not a string
  const wrong:string=await p.run('sum',{a:1,b:2});
  const numbers:number[]=await map([1,2],x=>x*2);
  const selected:number[]=await filter([1,2],x=>x>1);
  const f=multicore(async(a:number[])=>a.length,{reduce:(a,b)=>a+b});
  const total:number=await f([1,2]);
  const g=multicore(async(a:number[])=>a.length);
  const parts:number[]=await g([1,2]);
  void [n,b,list,wrong,numbers,selected,total,parts];
}
void contracts;
