import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  cp,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = join(root, "dist/ui/licenses");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function packageAt(name, parent = root) {
  const path = resolve(
    parent,
    "node_modules",
    ...name.split("/"),
    "package.json",
  );
  try {
    const resolved = await realpath(path);
    const metadata = JSON.parse(await readFile(resolved, "utf8"));
    if (metadata.name !== name) return null;
    return { root: dirname(resolved), metadata };
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
await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), lines.join("\n") + "\n");
console.log(
  JSON.stringify({
    packages: inventory.length,
    fontLicense: "SIL OFL 1.1",
    noticeFiles: inventory.reduce((n, item) => n + item.files.length, 0),
  }),
);
