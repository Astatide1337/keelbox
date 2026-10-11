import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const source = JSON.parse(await readFile("package.json", "utf8"));
const archive = resolve(
  process.argv[2] ?? `${source.name}-${source.version}.tgz`,
);
const archiveBytes = await readFile(archive);
const options = { encoding: "utf8", maxBuffer: 4_000_000 };
const entries = execFileSync("tar", ["-tzf", archive], options)
  .trim()
  .split("\n");
if (
  entries.some((p) => !p.startsWith("package/") || p.split("/").includes(".."))
)
  throw Error("Unsafe package archive path.");
const listing = execFileSync("tar", ["-tvzf", archive], options)
  .trim()
  .split("\n");
if (listing.some((line) => !line.startsWith("-")))
  throw Error("Package must contain regular files only.");
const paths = entries.map((p) => p.slice("package/".length));
const temp = await mkdtemp(join(tmpdir(), "waypoint-packed-proof-"));
try {
  execFileSync("tar", [
    "-xzf",
    archive,
    "--no-same-owner",
    "--no-same-permissions",
    "--strip-components=1",
    "-C",
    temp,
  ]);
  const manifest = JSON.parse(
    await readFile(join(temp, "package.json"), "utf8"),
  );
  if (
    manifest.name !== source.name ||
    manifest.version !== source.version ||
    manifest.license !== "MIT" ||
    !manifest.bin?.waypoint ||
    manifest.engines?.node !== source.engines.node
  )
    throw Error("Package metadata mismatch.");
  if (
    manifest.scripts?.postinstall ||
    manifest.scripts?.install ||
    manifest.scripts?.preinstall
  )
    throw Error("Installation must have no lifecycle side effects.");
  if (manifest.scripts?.prepack !== "npm run package:build")
    throw Error("Pack must build production output first.");
  for (const required of [
    "README.md",
    "LICENSE",
    "dist/cli/index.cjs",
    "dist/ui/server.js",
    "SETUP.md",
  ])
    if (!paths.includes(required))
      throw Error("Missing package file " + required);
  if (!paths.some((p) => p.startsWith("dist/ui/.next/static/")))
    throw Error("Missing static UI assets.");
  const forbidden = paths.filter(
    (p) =>
      /^(?!dist\/ui\/node_modules\/)(?:.*\/)?(?:server\.json|minikube-session\.json|credentials[^/]*\.json|auth-state\.json|.*\.kubeconfig|\.env[^/]*|.*\.log)$/.test(
        p,
      ) ||
      /^(?:tests|docs|\.git|\.waypoint|playwright-report|test-results)\//.test(
        p,
      ),
  );
  if (forbidden.length)
    throw Error("Excluded machine-local files found: " + forbidden.join(", "));
  let checked = 0,
    bytes = 0;
  for (const p of paths) {
    const file = await readFile(join(temp, p));
    bytes += file.length;
    if (file.length > 5_000_000 || file.includes(0)) continue;
    const content = file.toString("utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) ||
      /(?:sk-proj-|ghp_|github_pat_)[a-zA-Z0-9_]{25,}/.test(content)
    )
      throw Error("Credential marker found in packaged file " + p);
    checked++;
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      artifactSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      files: paths.length,
      textFilesScanned: checked,
      bytes,
      installHooks: false,
      staticAssets: true,
      license: manifest.license,
      scanScope:
        "path exclusions and supported credential markers in text files <=5MB; not an exhaustive semantic secret detector",
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
