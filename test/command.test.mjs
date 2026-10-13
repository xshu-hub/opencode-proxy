import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executableCommand } from '../lib/command.mjs';
import { OpenCodeBridge } from '../lib/bridge.mjs';

const reportedShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\opencode-ai\\bin\\opencode.exe"   %*\r\n';

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-shim-fixture-'));
  try {
    const bin = path.join(home, 'global bin');
    await mkdir(bin);
    const put = async (name, text = '') => { const file = path.join(bin, ...name.split('/')); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file; };
    await run({ bin, put, resolve: command => executableCommand(command, { platform: 'win32', env: { PATH: bin } }) });
  } finally {
    assert.ok(home.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(home, { recursive: true, force: true });
  }
}

test('the reported scoped npm CMD discovers the exact native executable, even beside an older unscoped install', async () => fixture(async ({ put, resolve }) => {
  await put('opencode.cmd', reportedShim);
  const expected = await put('node_modules/@opencode/opencode-ai/bin/opencode.exe');
  await put('node_modules/opencode-ai/package.json', JSON.stringify({ name: 'opencode-ai', bin: { opencode: './bin/older.exe' } }));
  await put('node_modules/opencode-ai/bin/older.exe');
  assert.deepEqual(await resolve(['opencode', '--existing-option']), [expected, '--existing-option']);
}));

test('PS1 and npm variable variants follow their actual scoped target without evaluating the wrapper', async () => fixture(async ({ put, resolve }) => {
  const expected = await put('node_modules/@opencode/opencode-ai/bin/opencode.exe');
  for (const [name, source] of [
    ['opencode.ps1', '& "$basedir/node_modules/@opencode/opencode-ai/bin/opencode.exe" $args'],
    ['opencode.cmd', '"%~dp0node_modules\\@opencode\\opencode-ai\\bin\\opencode.exe" %*'],
  ]) {
    const shim = await put(name, '\ufeff' + source);
    assert.deepEqual(await resolve([shim]), [expected]);
  }
}));

test('a JavaScript npm launcher uses Node from the selected install, preserving arguments', async () => fixture(async ({ put, resolve }) => {
  const node = await put('node.exe');
  const script = await put('node_modules/@opencode/opencode-ai/bin/opencode', '#!/usr/bin/env node\n');
  const shim = await put('opencode.cmd', '"%dp0%\\node_modules\\@opencode\\opencode-ai\\bin\\opencode" %*');
  assert.deepEqual(await resolve([shim, 'existing']), [node, script, 'existing']);
}));

test('existing unscoped manifest resolution keeps renamed native bins and UTF-8 BOM manifests working', async () => fixture(async ({ put, resolve }) => {
  const expected = await put('node_modules/opencode-ai/bin/renamed.exe');
  await put('node_modules/opencode-ai/package.json', '\ufeff' + JSON.stringify({ name: 'opencode-ai', bin: { opencode: './bin/renamed.exe' } }));
  const shim = await put('opencode.cmd', '@echo off');
  assert.deepEqual(await resolve([shim]), [expected]);
}));

test('an unresolved selected shim reports its path rather than selecting another installation', async () => fixture(async ({ bin, put, resolve }) => {
  const shim = await put('opencode.cmd', '"%dp0%\\node_modules\\@opencode\\opencode-ai\\bin\\missing.exe" %*');
  await assert.rejects(resolve(['opencode']), error => error.code === 'opencode_unavailable' && error.message.includes(shim) && error.message.includes('missing.exe'));
}));

test('native executables and non-Windows command arrays retain their selection', async () => {
  const command = ['a-program', 'existing'];
  assert.deepEqual(await executableCommand(command, { platform: 'linux' }), command);
  assert.deepEqual(await executableCommand(['C:/OpenCode/opencode.exe'], { platform: 'win32' }), ['C:/OpenCode/opencode.exe']);
});

test('model discovery failure exposes the actual OpenCode startup error', async () => fixture(async ({ bin }) => {
  const bridge = new OpenCodeBridge({mode:'global',command:[path.join(bin,'missing-opencode.exe')],startupTimeoutMs:500,diagnostics:false});
  try {
    const response=await bridge.fetch('http://proxy/v1/models',{method:'GET'});
    assert.equal(response.status,503);
    assert.match((await response.json()).error.message,/OpenCode/);
  } finally { await bridge.close(); }
}));
