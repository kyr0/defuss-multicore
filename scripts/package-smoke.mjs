import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise published exports from an isolated install, outside this source tree.
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'defuss-multicore-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const artifacts = join(temp, 'artifacts');
  mkdirSync(artifacts);
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', artifacts], {cwd:root, encoding:'utf8'}));
  writeFileSync(join(temp, 'package.json'), JSON.stringify({private:true,type:'module'}));
  execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(artifacts, packed.filename)], {cwd:temp, stdio:'pipe'});
  for (const format of ['esm', 'cjs']) {
    const extension = format === 'esm' ? 'mjs' : 'cjs';
    const workerImports = format === 'esm'
      ? "import { expose } from 'defuss-multicore/worker'; import { transfer } from 'defuss-multicore';"
      : "const { expose } = require('defuss-multicore/worker'); const { transfer } = require('defuss-multicore');";
    writeFileSync(join(temp, `worker.${extension}`), `${workerImports}
      void expose({double(values) { for (let i=0;i<values.length;i++) values[i]*=2; return transfer({values},[values.buffer]); }});`);
    const clientImports = format === 'esm'
      ? "import assert from 'node:assert/strict'; import { Worker } from 'node:worker_threads'; import { createPool, multicore, dotProduct } from 'defuss-multicore';"
      : "const assert = require('node:assert/strict'); const { Worker } = require('node:worker_threads'); const { createPool, multicore, dotProduct } = require('defuss-multicore');";
    writeFileSync(join(temp, `client.${extension}`), `${clientImports}
      (async () => {
        assert.deepEqual([...dotProduct([[1,2]],[[3,4]])],[11]);
        const pool = createPool({worker:()=>new Worker(${JSON.stringify(join(temp, `worker.${extension}`))}),maxWorkers:1});
        try {
          const input = new Uint8Array([3,4]);
          const result = await pool.run('double', input, {transfer:[input.buffer]});
          assert.equal(input.byteLength,0);
          assert.deepEqual([...result.values],[6,8]);
        } finally { await pool.close(); }
        const sum = multicore(values=>values.reduce((a,b)=>a+b,0),{cores:2,threshold:1,reduce:(a,b)=>a+b});
        try { assert.equal(await sum([1,2,3,4]),10); } finally { await sum.close(); }
      })().catch(error=>{ console.error(error); process.exitCode=1; });`);
    execFileSync(process.execPath, [join(temp, `client.${extension}`)], {cwd:temp,stdio:'pipe'});
  }
  const report={node:process.version,package:packed.name,version:packed.version,formats:['ESM','CJS'],checks:['isolated local-tarball install','root and worker exports','linear algebra','module workers','input/output transfers','legacy serialized workers'],success:true};
  console.log(JSON.stringify(report,null,2));
  if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
} finally { rmSync(temp,{recursive:true,force:true}); }
