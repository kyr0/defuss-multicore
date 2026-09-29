import { expose, transfer } from './worker.js';
import { getCoreCount } from './partition.js';
const tasks={
  add:({a,b}:{a:number;b:number})=>a+b,
  echo:(value:any)=>value,
  sleep:async({ms,value}:{ms:number;value:number})=>{await new Promise(r=>setTimeout(r,ms));return value;},
  double:(bytes:Uint8Array<ArrayBuffer>)=>{for(let i=0;i<bytes.length;i++)bytes[i]*=2;return transfer(bytes,[bytes.buffer]);},
  alias:(_v:null)=>{const a=new Uint8Array([1,2,3]);return transfer({a,b:a.subarray(1)},[a.buffer,a.buffer]);},
};
export type Tasks=typeof tasks;
void expose(tasks,{init:async()=>{await Promise.resolve();if(getCoreCount()<1)throw Error('Invalid hardware concurrency');}});
