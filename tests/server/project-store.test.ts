import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  stat,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore,
  readManifestInputs,
} from "../../lib/server/project-store";
test("CLI project import validates before atomic owner-only selection; malformed/Secret imports preserve prior selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-project-store-"));
  const store = new ProjectStore(join(dir, "state"));
  const file = join(dir, "service.yaml");
  try {
    assert.equal(await store.load(), null);
    await writeFile(
      file,
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: imported\n",
    );
    const selected = await store.select(await readManifestInputs([file]));
    assert.equal((await store.load())?.revision, selected.revision);
    assert.equal(
      (await stat(join(dir, "state/project.json"))).mode & 0o777,
      0o600,
    );
    const old = await readFile(join(dir, "state/project.json"), "utf8");
    await writeFile(file, "apiVersion: [");
    await assert.rejects(readManifestInputs([file]), /invalid YAML/);
    assert.equal(await readFile(join(dir, "state/project.json"), "utf8"), old);
    await writeFile(
      file,
      "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: forbidden\n  stringData:\n    token: example\n",
    );
    await assert.rejects(readManifestInputs([file]), /Secret/);
    assert.equal(await readFile(join(dir, "state/project.json"), "utf8"), old);
    await symlink(file, join(dir, "link.yaml"));
    await assert.rejects(
      readManifestInputs([join(dir, "link.yaml")]),
      /symlink/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("snapshot imports preserve captured provenance and selection revision changes on each publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-project-snapshot-"));
  try {
    const file = join(dir, "snapshot.json");
    await writeFile(
      file,
      await readFile("examples/storefront/snapshot.json", "utf8"),
    );
    const project = await readManifestInputs([file]);
    const store = new ProjectStore(join(dir, "state"));
    const a = await store.select(project);
    const b = await store.select(project);
    assert.notEqual(a.revision, b.revision);
    assert.equal((await store.load())?.project.id, project.id);
    assert.equal((await store.load())?.project.origin, "bundled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI collect publishes the captured snapshot using only explicit allowlisted reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-cli-collect-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const calls = join(dir, "calls.jsonl");
    await writeFile(
      join(bin, "kubectl"),
      '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync(process.env.CLI_TEST_CALLS, JSON.stringify(process.argv.slice(2))+"\\n"); console.log(JSON.stringify({items:[]}));\n',
      { mode: 0o700 },
    );
    const state = join(dir, "state"),
      out = join(dir, "capture.json");
    await promisify(execFile)(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "cli/index.ts",
        "collect",
        "--context",
        "minikube-test",
        "--namespaces",
        "hello-world",
        "--out",
        out,
      ],
      {
        env: {
          ...process.env,
          PLAYGROUND_STATE_DIR: state,
          CLI_TEST_CALLS: calls,
          PATH: bin + ":" + process.env.PATH,
        },
      },
    );
    const saved = await new ProjectStore(state).load();
    assert.equal(saved?.project.origin, "captured");
    assert.equal(saved?.project.label, "minikube-test");
    assert.equal(saved?.project.id, JSON.parse(await readFile(out, "utf8")).id);
    assert.equal(saved?.project.coverage.length, 8);
    const invoked = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invoked.length, 8);
    for (const args of invoked) {
      assert(args.includes("get"));
      assert(args.includes("minikube-test"));
      assert(args.includes("hello-world"));
      assert(!args.includes("apply"));
      assert(!args.includes("secrets"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
