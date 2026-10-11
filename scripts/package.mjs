import { build } from "esbuild";
import { cp, mkdir, rm, chmod, readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/cli", { recursive: true });
await build({
  entryPoints: ["cli/index.ts"],
  outfile: "dist/cli/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  external: [],
  logLevel: "info",
});
await chmod("dist/cli/index.cjs", 0o755);
await mkdir("dist/ui", { recursive: true });
for (const name of ["server.js", "package.json", ".next", "node_modules"])
  await cp(".next/standalone/" + name, "dist/ui/" + name, {
    recursive: true,
    dereference: true,
  });
await cp(
  ".next/standalone/node_modules/.pnpm/node_modules",
  "dist/ui/node_modules",
  { recursive: true, dereference: true, force: false },
).catch((error) => {
  // Some pnpm/Next standalone layouts keep every traced package under the
  // root node_modules/.pnpm tree and do not emit this additional link index.
  if (error.code !== "ENOENT") throw error;
});
// Dereferencing the root Next link relocates it away from pnpm's dependency
// siblings. Keep those traced runtime dependencies resolvable at the new root.
await cp(
  dirname(await realpath(".next/standalone/node_modules/next")),
  "dist/ui/node_modules",
  { recursive: true, dereference: true, force: false },
);
await cp(".next/standalone/examples", "dist/ui/examples", {
  recursive: true,
}).catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
await cp(".next/static", "dist/ui/.next/static", { recursive: true });
// Next reads this metadata at runtime. normalize-standalone rewrites its
// checkout paths together with the rest of the generated server files.
await cp("public", "dist/ui/public", { recursive: true }).catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
// Standalone traces are inspected by package tests; application state is never copied.
console.log(
  "Compiled CLI and production UI staged. No installation hooks or cluster operations.",
);
