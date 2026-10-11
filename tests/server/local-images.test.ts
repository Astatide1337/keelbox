import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dockerBuildContexts,
  resolveLocalImage,
} from "../../lib/server/local-images";
const id = `sha256:${"a".repeat(64)}`;
test("cached image is preferred without running a build", async () => {
  const calls: string[][] = [];
  const result = await resolveLocalImage(
    "example/app:v1",
    { "example/app:v1": "/missing/context" },
    async (_command, args) => {
      calls.push(args);
      return id;
    },
  );
  assert.equal(result.imageId, id);
  assert.deepEqual(
    calls.map((x) => x.slice(0, 2)),
    [["image", "inspect"]],
  );
});
test("missing image builds only the explicitly mapped context before registry fallback", async () => {
  const context = await mkdtemp(join(tmpdir(), "waypoint-image-test-"));
  await writeFile(join(context, "Dockerfile"), "FROM scratch\n");
  try {
    const calls: string[][] = [];
    let built = false;
    const result = await resolveLocalImage(
      "example/app:v1",
      { "example/app:v1": context },
      async (_command, args) => {
        calls.push(args);
        if (args[0] === "build") {
          built = true;
          return "";
        }
        if (!built)
          throw Error("docker failed (1): No such image: example/app:v1");
        return id;
      },
    );
    assert.equal(result.imageId, id);
    assert.deepEqual(
      calls.map((x) => x[0]),
      ["image", "build", "image"],
    );
    assert.deepEqual(calls[1], [
      "build",
      "--tag",
      "example/app:v1",
      "--file",
      join(context, "Dockerfile"),
      context,
    ]);
    const failed = await resolveLocalImage(
      "example/app:v1",
      { "example/app:v1": context },
      async (_command, args) => {
        if (args[0] === "build") throw Error("build failed");
        throw Error("No such image");
      },
    );
    assert.equal(failed.imageId, null);
    assert.equal(failed.buildError, "build failed");
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
test("unmapped images use registry, while daemon failures are not treated as cache misses", async () => {
  assert.equal(
    (
      await resolveLocalImage("registry/app:v1", {}, async () => {
        throw Error("No such image");
      })
    ).imageId,
    null,
  );
  await assert.rejects(
    resolveLocalImage("registry/app:v1", {}, async () => {
      throw Error("Cannot connect to Docker daemon");
    }),
    /Cannot connect/,
  );
});
test("build mappings reject relative contexts and invalid image arguments", () => {
  assert.throws(
    () => dockerBuildContexts('{"image":"./app"}'),
    /absolute directory/,
  );
  assert.throws(
    () => dockerBuildContexts('{"--flag":"/app"}'),
    /absolute directory/,
  );
  assert.throws(() => dockerBuildContexts("[]"), /map image/);
  assert.deepEqual(dockerBuildContexts('{"image:v1":"/trusted/app"}'), {
    "image:v1": "/trusted/app",
  });
});
test("unavailable configured build directory still permits registry fallback", async () => {
  const result = await resolveLocalImage(
    "example/app:v1",
    { "example/app:v1": "/tmp/waypoint-build-context-does-not-exist" },
    async () => {
      throw Error("No such image");
    },
  );
  assert.equal(result.imageId, null);
  assert.match(result.buildError!, /ENOENT/);
});
