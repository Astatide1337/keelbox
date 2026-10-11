import { readFile, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const projectRoot = process.cwd();
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
    "THIRD_PARTY_NOTICES.md",
    "dist/cli/index.cjs",
    "dist/ui/server.js",
    "examples/market-data/kustomization.yaml",
    "examples/market-data/manifests/producer-settings.yaml",
    "examples/market-data/src/producer.py",
    "examples/market-data/src/consumer.py",
    "examples/market-data/tests/test_local.py",
    "examples/market-data/tools/measure_detection.py",
    "dist/ui/licenses/@fontsource-variable__inter-5.3.0/LICENSE",
    "dist/ui/licenses/next-compiled/tar/LICENSE",
  ])
    if (!paths.includes(required))
      throw Error("Missing package file " + required);
  if (!paths.some((p) => p.startsWith("dist/ui/.next/static/")))
    throw Error("Missing static UI assets.");
  const forbidden = paths.filter(
    (p) =>
      /(^|\/)__pycache__(\/|$)|\.py[cod]$/i.test(p) ||
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
    if (/\/home\/[a-zA-Z0-9._-]+\//.test(content))
      throw Error(
        "Nonportable home-directory path found in packaged file " + p,
      );
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) ||
      /(?:sk-proj-|ghp_|github_pat_)[a-zA-Z0-9_]{25,}/.test(content)
    )
      throw Error("Credential marker found in packaged file " + p);
    checked++;
  }
  const fontLicense = await readFile(
    join(temp, "dist/ui/licenses/@fontsource-variable__inter-5.3.0/LICENSE"),
    "utf8",
  );
  if (!fontLicense.includes("SIL OPEN FONT LICENSE Version 1.1"))
    throw Error("Missing the full Inter SIL Open Font License 1.1 notice.");
  const thirdPartyNotices = await readFile(
    join(temp, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  if (!thirdPartyNotices.includes("Inter variable font"))
    throw Error("Third-party notice inventory omits the Inter font.");
  const nextRoot = await realpath(join(projectRoot, "node_modules", "next"));
  const compiledRoot = join(nextRoot, "dist", "compiled");
  const upstreamNotices = [];
  async function collectUpstreamNotices(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectUpstreamNotices(file);
      } else if (
        entry.isFile() &&
        /(license|licence|notice|copying)/i.test(entry.name)
      ) {
        upstreamNotices.push({
          source: file,
          relative: relative(compiledRoot, file).split(sep).join("/"),
        });
      }
    }
  }
  await collectUpstreamNotices(compiledRoot);
  if (upstreamNotices.length === 0)
    throw Error("No upstream Next.js vendored notices were found.");
  const expectedVendoredPaths = upstreamNotices
    .map(({ relative }) => "dist/ui/licenses/next-compiled/" + relative)
    .sort();
  const actualVendoredPaths = paths
    .filter((p) => p.startsWith("dist/ui/licenses/next-compiled/"))
    .sort();
  if (
    expectedVendoredPaths.length !== actualVendoredPaths.length ||
    expectedVendoredPaths.some((p, i) => p !== actualVendoredPaths[i])
  )
    throw Error("Package omits or adds Next.js vendored license/notice files.");
  for (const notice of upstreamNotices) {
    const packaged = await readFile(
      join(temp, "dist/ui/licenses/next-compiled", notice.relative),
    );
    const authentic = await readFile(notice.source);
    if (!packaged.equals(authentic))
      throw Error(
        "Next.js vendored notice was not copied verbatim: " + notice.relative,
      );
  }
  const tarMetadata = JSON.parse(
    await readFile(join(compiledRoot, "tar", "package.json"), "utf8"),
  );
  const blueOakLicensePath = "next-compiled/tar/LICENSE";
  const blueOakArchivePath = "dist/ui/licenses/" + blueOakLicensePath;
  const blueOakLicense = await readFile(join(temp, blueOakArchivePath), "utf8");
  if (
    tarMetadata.license !== "BlueOak-1.0.0" ||
    !blueOakLicense.includes("# Blue Oak Model License") ||
    !blueOakLicense.includes("Version 1.0.0") ||
    !thirdPartyNotices.includes(
      "[" +
        blueOakLicensePath +
        "](dist/ui/licenses/" +
        blueOakLicensePath +
        ")",
    ) ||
    !thirdPartyNotices.includes("BlueOak-1.0.0")
  )
    throw Error(
      "The authentic vendored tar Blue Oak license is not documented.",
    );

  console.log(
    JSON.stringify({
      status: "PASS",
      artifactSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      files: paths.length,
      textFilesScanned: checked,
      bytes,
      installHooks: false,
      staticAssets: true,
      nextVendoredNoticeFiles: upstreamNotices.length,
      blueOakTarLicense: "PASS",
      license: manifest.license,
      scanScope:
        "path exclusions and supported credential markers in text files <=5MB; not an exhaustive semantic secret detector",
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
