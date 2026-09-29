import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const root = new URL('../examples/vite/', import.meta.url).pathname;
await build({root,configFile:new URL('../examples/vite/vite.config.ts',import.meta.url).pathname});
const server=await preview({root,configFile:new URL('../examples/vite/vite.config.ts',import.meta.url).pathname,preview:{host:'127.0.0.1',port:0}});
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(()=>typeof window.__run==='function');
  const result=await page.evaluate(()=>window.__run());
  if(errors.length||result.length!==4||!result.slice(1).every(r=>r.equal&&r.stats.workers===r.workers))throw Error(JSON.stringify({errors,result}));
  const report={browser:browser.version(),mode:'Vite production bundle, real module workers',result};
  console.log(JSON.stringify(report,null,2));
  if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
