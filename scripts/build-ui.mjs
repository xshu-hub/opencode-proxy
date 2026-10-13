import { cp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
const frontend = path.resolve(import.meta.dirname, "../frontend");
const files = await readdir(path.join(frontend, "src"));
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const result = spawnSync(
    process.execPath,
    ["--check", path.join(frontend, "src", f)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status);
}
const output = path.join(frontend, "dist");
// Fixed build-owned directory; it contains no user configuration.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files)
  await cp(path.join(frontend, "src", file), path.join(output, file));
await writeFile(
  path.join(output, "index.html"),
  await readFile(path.join(frontend, "index.html")),
);
console.log(
  "Built standalone UI: native ES modules + CSS, zero runtime dependencies.",
);
