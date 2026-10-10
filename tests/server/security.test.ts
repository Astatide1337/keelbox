import { test } from "node:test";
import assert from "node:assert/strict";
import { authorized, boundedJson, validHost } from "../../lib/server/security";
import { beginSignIn, accounts, inference } from "../../lib/server/oauth";
test("unauthenticated and foreign Host requests denied", () => {
  assert.equal(authorized(new Request("http://127.0.0.1:3000/api/lab")), false);
  assert.equal(
    validHost(
      new Request("http://127.0.0.1:3000", {
        headers: { host: "evil.example" },
      }),
    ),
    false,
  );
});
test("valid CLI token needs exact local origin for mutation", () => {
  process.env.PLAYGROUND_API_TOKEN = "test-app-owned-token";
  const headers = {
    host: "127.0.0.1:3000",
    authorization: "Bearer test-app-owned-token",
    origin: "http://127.0.0.1:3000",
  };
  assert.equal(
    authorized(new Request("http://127.0.0.1:3000", { headers }), true),
    true,
  );
  assert.equal(
    authorized(
      new Request("http://127.0.0.1:3000", {
        headers: { ...headers, origin: "http://evil.example" },
      }),
      true,
    ),
    false,
  );
});
test("body size bound rejects oversized input", async () => {
  await assert.rejects(
    () =>
      boundedJson(
        new Request("http://local", {
          method: "POST",
          body: '{"data":"oversized"}',
        }),
        5,
      ),
    /too large/,
  );
});
test("development mode cannot initiate OAuth or persist credentials", async () => {
  delete process.env.PLAYGROUND_AI_ENABLED;
  delete process.env.PLAYGROUND_ALLOW_CREDENTIAL_STORAGE;
  await assert.rejects(beginSignIn("test-owner"), /disabled/);
  assert.deepEqual(await accounts(), []);
  await assert.rejects(
    inference(
      {
        profile: {
          kind: "development",
          key: "development",
          label: "Local development",
        },
        epoch: "development",
      },
      "unused",
      {},
    ),
    /disabled/,
  );
});
import { kubeconfigIdentity } from "../../lib/server/ownership";
test("kubeconfig context changes, added clusters and exec credential plugins refused", () => {
  const name = "kind-playground-test";
  const config = {
    clusters: [
      {
        name,
        cluster: {
          server: "https://127.0.0.1:12345",
          "certificate-authority-data": "owned-ca",
        },
      },
    ],
    contexts: [{ name, context: { cluster: name, user: name } }],
    users: [
      {
        name,
        user: {
          "client-certificate-data": "owned-cert",
          "client-key-data": "owned-key",
        },
      },
    ],
    "current-context": name,
  };
  assert.ok(kubeconfigIdentity(config, "playground-test"));
  const changed = structuredClone(config);
  changed["current-context"] = "production";
  assert.throws(() => kubeconfigIdentity(changed, "playground-test"));
  const extra = structuredClone(config);
  extra.clusters.push({
    name: "production",
    cluster: {
      server: "https://production.example",
      "certificate-authority-data": "other",
    },
  });
  assert.throws(() => kubeconfigIdentity(extra, "playground-test"));
  const plugin = structuredClone(config);
  Object.assign(plugin.users[0].user, { exec: { command: "arbitrary" } });
  assert.throws(() => kubeconfigIdentity(plugin, "playground-test"));
});
