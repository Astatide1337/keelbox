import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  cp,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = join(root, "dist/ui/licenses");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function packageAt(name, parent = root) {
  try {
    const require = createRequire(join(parent, "package.json"));
    let directory;
    try {
      directory = dirname(
        await realpath(require.resolve(name + "/package.json")),
      );
    } catch {
      // Some packages restrict package.json exports. Resolve their entry point
      // without executing it, then locate the matching package metadata.
      directory = dirname(await realpath(require.resolve(name)));
    }
    while (directory !== dirname(directory)) {
      try {
        const metadata = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (metadata.name === name) return { root: directory, metadata };
      } catch {}
      directory = dirname(directory);
    }
    return null;
  } catch {
    return null;
  }
}

const queue = Object.keys({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})
  .sort()
  .map(async (name) => ({ name, parent: root }));
const pending = await Promise.all(queue);
const visited = new Set();
const packages = [];
while (pending.length) {
  const { name, parent } = pending.shift();
  const resolved =
    (await packageAt(name, parent)) ?? (await packageAt(name, root));
  if (!resolved) continue;
  const identity = `${resolved.metadata.name}@${resolved.metadata.version}`;
  if (visited.has(identity)) continue;
  visited.add(identity);
  packages.push(resolved);
  for (const child of Object.keys({
    ...resolved.metadata.dependencies,
    ...resolved.metadata.optionalDependencies,
  }).sort())
    pending.push({ name: child, parent: resolved.root });
  for (const peer of Object.keys(
    resolved.metadata.peerDependencies ?? {},
  ).sort())
    if (await packageAt(peer, resolved.root))
      pending.push({ name: peer, parent: resolved.root });
}

const inventory = [];
for (const { root: packageRoot, metadata } of packages.sort(
  (a, b) =>
    a.metadata.name.localeCompare(b.metadata.name) ||
    a.metadata.version.localeCompare(b.metadata.version),
)) {
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const notices = entries.filter(
    (entry) =>
      entry.isFile() && /(license|licence|notice|copying)/i.test(entry.name),
  );
  const license =
    typeof metadata.license === "string"
      ? metadata.license
      : metadata.license
        ? JSON.stringify(metadata.license)
        : "unspecified by package metadata";
  const directory = `${metadata.name.replaceAll("/", "__").replaceAll("@", "")}-${metadata.version}`;
  await mkdir(join(output, directory), { recursive: true });
  const files = [];
  for (const notice of notices.sort((a, b) => a.name.localeCompare(b.name))) {
    const destination = join(directory, notice.name);
    await cp(join(packageRoot, notice.name), join(output, destination));
    files.push(destination);
  }
  inventory.push({
    name: metadata.name,
    version: metadata.version,
    license,
    files,
  });
}

const nextPackage = await packageAt("next", root);
if (!nextPackage) throw Error("The installed Next.js package is missing.");
const compiledRoot = join(nextPackage.root, "dist", "compiled");
const bundledNotices = [];

async function collectCompiledNotices(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectCompiledNotices(source);
      continue;
    }
    if (
      !entry.isFile() ||
      !/(license|licence|notice|copying)/i.test(entry.name)
    )
      continue;

    let packageRoot = dirname(source);
    let metadata = null;
    while (
      packageRoot !== compiledRoot &&
      packageRoot.startsWith(compiledRoot)
    ) {
      try {
        const candidate = JSON.parse(
          await readFile(join(packageRoot, "package.json"), "utf8"),
        );
        if (typeof candidate.name === "string") {
          metadata = candidate;
          break;
        }
      } catch {}
      packageRoot = dirname(packageRoot);
    }
    if (!metadata)
      throw Error(
        "Missing bundled package metadata for Next.js notice " +
          relative(compiledRoot, source),
      );

    const sourceRelative = relative(compiledRoot, source).split(sep).join("/");
    const destination = "next-compiled/" + sourceRelative;
    const destinationPath = join(output, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(source, destinationPath);
    bundledNotices.push({
      name: metadata.name,
      version: metadata.version ?? "not declared in bundled package metadata",
      license:
        typeof metadata.license === "string"
          ? metadata.license
          : metadata.license
            ? JSON.stringify(metadata.license)
            : "unspecified by bundled package metadata",
      file: destination,
    });
  }
}

await collectCompiledNotices(compiledRoot);
if (
  !bundledNotices.some((notice) => notice.file === "next-compiled/tar/LICENSE")
)
  throw Error("Next.js vendored tar license is missing.");
const vendoredTarMetadata = JSON.parse(
  await readFile(join(compiledRoot, "tar", "package.json"), "utf8"),
);
const vendoredTarLicense = await readFile(
  join(compiledRoot, "tar", "LICENSE"),
  "utf8",
);
if (
  vendoredTarMetadata.license !== "BlueOak-1.0.0" ||
  !vendoredTarLicense.includes("# Blue Oak Model License") ||
  !vendoredTarLicense.includes("Version 1.0.0")
)
  throw Error("Next.js authentic Blue Oak Model License notice is missing.");

const font = await packageAt("@fontsource-variable/inter", root);
if (!font) throw Error("The bundled Inter font package is missing.");
const fontLicense = await readFile(join(font.root, "LICENSE"));
if (!fontLicense.includes(Buffer.from("SIL OPEN FONT LICENSE Version 1.1")))
  throw Error("The Inter font license is not the authentic OFL 1.1 notice.");
const fontPath = "@fontsource-variable__inter-5.3.0/LICENSE";
await mkdir(join(output, "@fontsource-variable__inter-5.3.0"), {
  recursive: true,
});
await writeFile(join(output, fontPath), fontLicense);

const lines = [
  "# Third-party notices",
  "",
  "Waypoint is licensed under MIT; see `LICENSE`. This inventory records the installed packages used by the compiled CLI and UI build. License and notice files are copied verbatim from each package. Build-only entries may be included so the inventory remains complete for the lockfile and packaging toolchain.",
  "",
  `Packages inspected: ${inventory.length}. The Inter variable font is distributed under the SIL Open Font License 1.1; its complete notice is in [${fontPath}](dist/ui/licenses/${fontPath}).`,
  "",
  "| Package | Version | Declared license | Included notice files |",
  "| --- | --- | --- | --- |",
];
for (const item of inventory) {
  const files = item.files.length
    ? item.files.map((file) => `[${file}](dist/ui/licenses/${file})`).join(", ")
    : "No separate license file shipped by package";
  lines.push(
    `| ${item.name} | ${item.version} | ${item.license.replaceAll("|", "\\|")} | ${files} |`,
  );
}
lines.push(
  "",
  "## Next.js vendored dependencies",
  "",
  "Next.js " +
    nextPackage.metadata.version +
    " ships " +
    bundledNotices.length +
    " embedded third-party license and notice files. Each file below is copied verbatim from next/dist/compiled; package names, versions, and declared licenses come from the nearest bundled package.json.",
  "",
  "| Bundled package | Version | Declared license | Included notice file |",
  "| --- | --- | --- | --- |",
);
for (const notice of bundledNotices.sort((a, b) =>
  a.file.localeCompare(b.file),
)) {
  lines.push(
    "| " +
      notice.name.replaceAll("|", "\\|") +
      " | " +
      notice.version.replaceAll("|", "\\|") +
      " | " +
      notice.license.replaceAll("|", "\\|") +
      " | [" +
      notice.file +
      "](dist/ui/licenses/" +
      notice.file +
      ") |",
  );
}
await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), lines.join("\n") + "\n");
console.log(
  JSON.stringify({
    packages: inventory.length,
    fontLicense: "SIL OFL 1.1",
    noticeFiles: inventory.reduce((n, item) => n + item.files.length, 0),
    nextVendoredNoticeFiles: bundledNotices.length,
    blueOakTarLicense: "verified",
  }),
);
