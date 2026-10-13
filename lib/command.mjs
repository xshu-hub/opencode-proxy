import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { ApiError } from './protocol.mjs';

const exists = file => stat(file).then(s => s.isFile(), () => false);
const text = bytes => (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')).replace(/^\uFEFF/, '');
const unavailable = message => new ApiError(message, 503, null, 'opencode_unavailable');

async function onPath(name, env, extensions) {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of path.extname(name) ? [name] : extensions.map(ext => name + ext)) {
      const file = path.join(dir.replace(/^"|"$/g, ''), candidate);
      if (await exists(file)) return file;
    }
  }
}

function targets(source, shim) {
  const found = [];
  for (const match of source.matchAll(/["']([^"'\r\n]+)["']/g)) {
    const value = match[1];
    const relative = value.replace(/^(?:%~dp0|%dp0%|\$\{basedir\}|\$basedir)[\\\/]*/i, '');
    if (relative === value && !/^[a-z]:[\\\/]/i.test(value)) continue;
    if (!/(?:^|[\\\/])node_modules[\\\/]/i.test(relative) || /[%]/.test(relative)) continue;
    const normalized = relative.replace(/[\\\/]/g, path.sep);
    found.push(relative === value ? path.normalize(normalized) : path.resolve(path.dirname(shim), normalized));
  }
  return [...new Set(found)];
}

function packageRoot(entry) {
  const parts = entry.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || !parts[i + 1]) return;
  const count = parts[i + 1].startsWith('@') ? 2 : 1;
  return parts.slice(0, i + 1 + count).join(path.sep);
}

async function declaredBin(root) {
  if (!root) return;
  const file = path.join(root, 'package.json');
  if (!await exists(file)) return;
  let pkg;
  try { pkg = JSON.parse(text(await readFile(file))); }
  catch { throw unavailable(`Cannot read the OpenCode launcher package manifest: ${file}.`); }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.opencode;
  if (typeof bin !== 'string') return;
  const entry = path.resolve(root, bin);
  return await exists(entry) ? entry : undefined;
}

async function launcher(entry, shim, env, args) {
  if (/\.(exe|com)$/i.test(entry)) return [entry, ...args];
  const source = text(await readFile(entry));
  if (/\.[cm]?js$/i.test(entry) || /^#![^\r\n]*\bnode\b/.test(source)) {
    const adjacent = path.join(path.dirname(shim), 'node.exe');
    const node = await exists(adjacent) ? adjacent : await onPath('node', env, ['.exe', '.com']);
    if (!node) throw unavailable(`OpenCode's JavaScript launcher needs Node.js on PATH: ${entry}.`);
    return [node, entry, ...args];
  }
  throw unavailable(`Unsupported OpenCode launcher: ${entry}. Set command to its actual executable or a node/script array.`);
}

export async function executableCommand(command, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return command;
  let selected = command[0];
  if (!selected.includes('/') && !selected.includes('\\')) selected = await onPath(selected, env, ['.exe', '.com', '.cmd', '.bat', '.ps1', '']) ?? selected;
  if (!/\.(cmd|bat|ps1)$/i.test(selected)) return [selected, ...command.slice(1)];

  // Follow the selected wrapper's static package target. A scoped/new install
  // must not silently resolve to an older unscoped package beside it.
  const source = await readFile(selected).then(text, () => '');
  const entries = targets(source, selected);
  for (const entry of entries) {
    if (await exists(entry)) return launcher(entry, selected, env, command.slice(1));
    const declared = await declaredBin(packageRoot(entry));
    if (declared) return launcher(declared, selected, env, command.slice(1));
  }
  if (entries.length) throw unavailable(`OpenCode launcher target is missing or unreadable: ${entries[0]} (from ${selected}). Set command to the actual OpenCode executable.`);

  // Retain manifest-only resolution for older npm wrappers and renamed bins.
  for (const root of [path.join(path.dirname(selected), 'node_modules', 'opencode-ai'), path.resolve(path.dirname(selected), '..', 'opencode-ai')]) {
    const entry = await declaredBin(root);
    if (entry) return launcher(entry, selected, env, command.slice(1));
  }
  throw unavailable(`Cannot resolve this Windows OpenCode shim: ${selected}. Set command to the actual OpenCode executable or a node/script array.`);
}
