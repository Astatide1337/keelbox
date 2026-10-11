import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const buildRoot = resolve(process.cwd());
const serverPath = join(buildRoot, "dist/ui/server.js");
let server = await readFile(serverPath, "utf8");

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0)
    throw new Error(
      `Expected exactly one generated ${label} path in server.js.`,
    );
  return source.slice(0, first) + after + source.slice(first + before.length);
}

// Next serializes the build checkout into its standalone config. The packaged
// server changes cwd to its own directory, so use that directory as the root
// when Next resolves these relative paths at runtime.
server = replaceOnce(
  server,
  `"outputFileTracingRoot":${JSON.stringify(buildRoot)}`,
  '"outputFileTracingRoot":"."',
  "outputFileTracingRoot",
);
server = replaceOnce(
  server,
  `"repoRoot":${JSON.stringify(buildRoot)}`,
  '"repoRoot":"."',
  "repoRoot",
);
server = replaceOnce(
  server,
  `"turbopack":{"root":${JSON.stringify(buildRoot)}`,
  '"turbopack":{"root":"."',
  "turbopack root",
);

await writeFile(serverPath, server);

let normalizedFiles = 0;
async function normalizeGeneratedPaths(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeGeneratedPaths(path);
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (bytes.includes(0)) continue;
      const content = bytes.toString("utf8");
      if (!content.includes(buildRoot)) continue;
      // Webpack can emit the same absolute source prefix into server module
      // IDs and client-reference manifests. Normalize every generated copy
      // together so those keys remain aligned in the relocated package.
      await writeFile(path, content.replaceAll(buildRoot, "."));
      normalizedFiles++;
    }
  }
}

await normalizeGeneratedPaths(join(buildRoot, "dist/ui/.next"));
console.log(
  `Normalized standalone server roots and ${normalizedFiles} generated files for relocatable packaging.`,
);
