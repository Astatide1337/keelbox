import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  LiveCache,
  type CacheStatus,
} from "../../lib/server/observations/cache";
import type { ObjectMap } from "../../lib/domain/types";

function stream(statusCode: number, records: unknown[] = []) {
  const readable = Readable.from(
    records.map((r) => JSON.stringify(r) + "\n"),
  ) as IncomingMessage;
  readable.statusCode = statusCode;
  return readable;
}
function harness() {
  const cache = new LiveCache({ namespace: "lab" } as never);
  const status: CacheStatus = {
    kind: "Pod",
    state: "connecting",
    receivedAt: null,
    resourceVersion: "",
  };
  cache.statuses.push(status);
  const internals = cache as unknown as {
    json: (path: string) => Promise<ObjectMap>;
    response: (path: string) => Promise<IncomingMessage>;
    delay: (ms: number) => Promise<void>;
    watch: (kind: string, status: CacheStatus) => Promise<void>;
  };
  const pod = (uid: string, resourceVersion: string) => ({
    metadata: { uid, name: "same-name", namespace: "lab", resourceVersion },
  });
  internals.json = async () => ({
    metadata: { resourceVersion: "10" },
    items: [pod("old-uid", "10")],
  });
  return { cache, status, internals, pod };
}

test("consecutive watch connection failures back off and retain the last confirmed receipt", async () => {
  const { cache, status, internals, pod } = harness();
  const delays: number[] = [];
  let requests = 0,
    confirmedReceipt: string | null;
  internals.response = async () => {
    requests++;
    assert.equal(
      status.state,
      "connecting",
      "A pending reconnect must not be presented as current.",
    );
    if (requests === 1) confirmedReceipt = status.receivedAt;
    if (requests <= 3) {
      assert.equal(
        status.receivedAt,
        confirmedReceipt,
        "Retries must not invent new observation timestamps.",
      );
      throw Error("connection refused");
    }
    if (requests === 4)
      return stream(200, [
        { type: "ADDED", object: pod("new-uid", "11") },
        { type: "DELETED", object: pod("old-uid", "12") },
      ]);
    throw Error("test stopping after valid recovery");
  };
  internals.delay = async (ms) => {
    delays.push(ms);
    if (delays.length === 4) cache.stop();
  };
  await internals.watch("Pod", status);
  for (const [index, lower] of [2000, 4000, 8000].entries())
    assert(delays[index] >= lower && delays[index] < lower + 250);
  assert(
    delays[3] >= 2000 && delays[3] < 2250,
    "A valid recovered frame resets retry backoff.",
  );
  assert.equal(status.resourceVersion, "12");
  assert.deepEqual(
    cache
      .view()
      .resources.map((resource) => (resource.metadata as ObjectMap).uid),
    ["new-uid"],
  );
});

test("expired history relists by UID and does not erase the last cache during reconnect", async () => {
  const { cache, status, internals, pod } = harness();
  let lists = 0,
    requests = 0,
    retry = 0;
  const versions: string[] = [];
  internals.json = async () => {
    lists++;
    return {
      metadata: { resourceVersion: lists === 1 ? "10" : "20" },
      items: [
        pod(
          lists === 1 ? "old-uid" : "relisted-uid",
          lists === 1 ? "10" : "20",
        ),
      ],
    };
  };
  internals.response = async (path) => {
    versions.push(
      new URL("https://owned.invalid" + path).searchParams.get(
        "resourceVersion",
      )!,
    );
    requests++;
    if (requests === 1) return stream(410);
    if (requests === 2)
      return stream(200, [
        { type: "BOOKMARK", object: { metadata: { resourceVersion: "21" } } },
      ]);
    throw Error("test stopping");
  };
  internals.delay = async () => {
    retry++;
    if (retry === 1) {
      assert.equal(status.resourceVersion, "");
      assert.equal(status.state, "stale");
      assert.equal(
        (cache.view().resources[0].metadata as ObjectMap).uid,
        "old-uid",
      );
    } else cache.stop();
  };
  await internals.watch("Pod", status);
  assert.equal(lists, 2);
  assert.deepEqual(versions.slice(0, 2), ["10", "20"]);
  assert.equal(status.resourceVersion, "21");
  assert.deepEqual(
    cache
      .view()
      .resources.map((resource) => (resource.metadata as ObjectMap).uid),
    ["relisted-uid"],
  );
});

test("empty immediate watches and malformed frames do not report a successful observation", async () => {
  for (const records of [
    [],
    [
      {
        type: "UNRECOGNIZED",
        object: { metadata: { resourceVersion: "bad" } },
      },
    ],
  ]) {
    const { cache, status, internals } = harness();
    let confirmedReceipt: string | null = null;
    internals.response = async () => {
      confirmedReceipt = status.receivedAt;
      return stream(200, records);
    };
    internals.delay = async () => {
      assert.equal(status.state, "stale");
      assert.equal(status.receivedAt, confirmedReceipt);
      assert(status.error);
      cache.stop();
    };
    await internals.watch("Pod", status);
    assert.equal(status.resourceVersion, "10");
  }
});
