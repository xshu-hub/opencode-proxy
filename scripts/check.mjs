import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as entry from '../index.mjs';

const files = ['index.mjs'];
for (const dir of ['lib', 'scripts', 'test']) {
  for (const file of await readdir(dir)) if (file.endsWith('.mjs')) files.push(`${dir}/${file}`);
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
assert.deepEqual(Object.keys(entry), ['OpenCodeProxyPlugin'], 'Magpie invokes every exported function as a plugin');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(pkg.main, './index.mjs');
assert.equal(pkg.exports, './index.mjs');
assert.equal(pkg.bin, undefined);
assert.equal(pkg.magpie.maxConcurrency, undefined, 'Magpie owns admission; the plugin must not add a default cap');
assert.ok(pkg.magpie.options && Object.keys(pkg.magpie.options).length, 'Magpie needs an options example to show the initial Options button');
const hooks = await entry.OpenCodeProxyPlugin({ magpie: {}, directory: process.cwd() }, pkg.magpie.options);
await hooks.dispose();
console.log(`Checked ${files.length} modules and the Magpie entry contract.`);
