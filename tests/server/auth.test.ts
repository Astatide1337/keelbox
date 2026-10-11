import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { mkdtemp, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateIdentityToken,
  inference,
  beginSignIn,
  authorizationUrl,
  cancelSignIn,
  attemptStatus,
  signOut,
  loginOwner,
} from "../../lib/server/oauth";
import {
  activateProfile,
  requirePrincipal,
  assertPrincipal,
} from "../../lib/server/auth/session";
import {
  profileFor,
  issuer,
  type Credential,
} from "../../lib/server/auth/identity";
import {
  writeAccount,
  hostId,
  readAccount,
  saveSelection,
  selectedAccount,
} from "../../lib/server/auth/credentials";
import { ownedStores } from "../../lib/server/auth/stores";
import { projectResources, importSnapshot } from "../../lib/domain/snapshot";
import { tutorContext } from "../../lib/tutor/context";
import { createExercise } from "../../lib/practice/engine";
import fixture from "../../examples/storefront/snapshot.json";
test("browser attempt owner survives cookie rotation; CLI ownership remains separate", () => {
  const before = loginOwner(
    new Request("http://local", { headers: { cookie: "playground=before" } }),
  );
  const after = loginOwner(
    new Request("http://local", { headers: { cookie: "playground=after" } }),
  );
  assert.equal(before, after);
  assert.notEqual(
    before,
    loginOwner(
      new Request("http://local", {
        headers: { authorization: "Bearer fixture-local-capability" },
      }),
    ),
  );
});
test("identity validation rejects wrong issuer, audience, signature, nonce, expired token and returning subject", async () => {
  const keys = await generateKeyPair("RS256"),
    other = await generateKeyPair("RS256");
  async function token(overrides: Record<string, unknown> = {}) {
    return new SignJWT({ nonce: "expected", ...overrides })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(String(overrides.iss ?? issuer))
      .setAudience(String(overrides.aud ?? "issued-client"))
      .setSubject(String(overrides.sub ?? "person-a"))
      .setIssuedAt()
      .setExpirationTime(
        (overrides.exp as number) ?? Math.floor(Date.now() / 1000) + 60,
      )
      .sign(keys.privateKey);
  }
  assert.equal(
    (
      await validateIdentityToken(
        await token(),
        "issued-client",
        "expected",
        "person-a",
        keys.publicKey,
      )
    ).sub,
    "person-a",
  );
  for (const values of [
    { iss: "https://evil.example" },
    { aud: "other-client" },
    { nonce: "wrong" },
    { exp: 1 },
    { sub: "person-b" },
  ])
    await assert.rejects(
      validateIdentityToken(
        await token(values),
        "issued-client",
        "expected",
        "person-a",
        keys.publicKey,
      ),
    );
  await assert.rejects(
    validateIdentityToken(
      await token(),
      "issued-client",
      "expected",
      "person-a",
      other.publicKey,
    ),
  );
});
test("local accounts isolate project and checkpoints, retain development source, reject old epoch; outgoing context excludes secret canaries; SSE requires completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-auth-test-"));
  process.env.PLAYGROUND_AUTH_DIR = join(root, "auth");
  process.env.PLAYGROUND_STATE_DIR = join(root, "state");
  process.env.PLAYGROUND_AI_ENABLED = "1";
  process.env.PLAYGROUND_ALLOW_CREDENTIAL_STORAGE = "1";
  const c: Credential = {
    issuer,
    client_id: "client-a",
    subject: "person-a",
    email: "test@example.invalid",
    label: "A",
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    id_token: "fixture-id",
    scopes: ["chatgpt.tokens.use.direct"],
    expires_at: Date.now() + 3600000,
    ext_agent_host_id: await hostId(),
    welcomed: false,
  };
  await writeAccount(c);
  assert.equal(
    (await stat(process.env.PLAYGROUND_AUTH_DIR)).mode & 0o777,
    0o700,
  );
  assert.equal(await hostId(), c.ext_agent_host_id);
  assert.equal((await readAccount(c.client_id)).subject, c.subject);
  const a = activateProfile(profileFor(c));
  const p = { profile: a.profile!, epoch: a.epoch };
  const headers = {
    "x-waypoint-profile": p.profile.key,
    "x-waypoint-epoch": p.epoch,
  };
  assert.equal(
    requirePrincipal(new Request("http://local", { headers })).profile.key,
    p.profile.key,
  );
  const stores = ownedStores(p);
  await stores.project.select(
    importSnapshot(JSON.stringify(fixture)),
    stores.guard,
  );
  const exercise = createExercise(
    importSnapshot(JSON.stringify(fixture)),
    "readiness",
  );
  await stores.exercises.save(exercise, null, undefined, stores.guard);
  const b = activateProfile(
    profileFor({
      ...c,
      client_id: "client-b",
      subject: "person-b",
      label: "B",
    }),
  );
  const other = ownedStores({ profile: b.profile!, epoch: b.epoch });
  assert.equal(await other.project.load(), null);
  assert.equal((await other.exercises.list()).items.length, 0);
  await assert.rejects(
    stores.project.select(
      importSnapshot(JSON.stringify(fixture)),
      stores.guard,
    ),
    /Account changed/,
  );
  assert.throws(() => assertPrincipal(p), /Account changed/);
  assert.throws(
    () => requirePrincipal(new Request("http://local", { headers })),
    /Account changed/,
  );
  const third = activateProfile(
    profileFor({ ...c, client_id: "client-a", subject: "person-a" }),
  );
  const active = { profile: third.profile!, epoch: third.epoch };
  const source = importSnapshot(JSON.stringify(fixture));
  const pod = projectResources(source).find((r) => r.kind === "Pod")!;
  const scoped = tutorContext(source, { resourceId: pod.id });
  assert.ok(scoped.context.evidence.some((e) => e.kind === "Deployment"));
  assert.ok(scoped.context.relationships.some((r) => r.kind === "owns"));
  const dirty = JSON.parse(JSON.stringify(fixture));
  dirty.resources.find((r: { kind: string }) => r.kind === "ConfigMap").data = {
    private: "canary-config-value",
  };
  dirty.files[0].content += "\n# canary-source-comment\n";
  const deployment = dirty.resources.find(
    (r: { kind: string }) => r.kind === "Deployment",
  );
  deployment.spec.template.spec.containers[0].env = [
    { name: "DATABASE_PASSWORD", value: "canary-env-value" },
  ];
  deployment.metadata.annotations = { note: "canary-annotation" };
  deployment.spec.replicas = "canary-numeric-private";
  deployment.spec.template.spec.containers[0].readinessProbe.periodSeconds = {
    private: "canary-probe-private",
  };
  const context = JSON.stringify(
    tutorContext(importSnapshot(JSON.stringify(dirty)), {}),
  );
  for (const canary of [
    "canary-config-value",
    "canary-source-comment",
    "canary-env-value",
    "canary-annotation",
    "fixture-access",
    "canary-numeric-private",
    "canary-probe-private",
  ])
    assert.ok(!context.includes(canary));
  const attempt = await beginSignIn("owner-a");
  const url = new URL(
    authorizationUrl(new URL(attempt.url).searchParams.get("ticket")!),
  );
  assert.equal(url.hostname, "auth.openai.com");
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.throws(
    () => authorizationUrl(new URL(attempt.url).searchParams.get("ticket")!),
    /expired/,
  );
  assert.throws(
    () => attemptStatus(attempt.attemptId, "owner-b"),
    /another local session/,
  );
  cancelSignIn(attempt.attemptId, "owner-a");
  assert.equal(attemptStatus(attempt.attemptId, "owner-a").state, "cancelled");
  const originalFetch = globalThis.fetch;
  try {
    let stream =
      'data: {"type":"response.output_text.delta","delta":"test"}\n\ndata: {"type":"response.completed"}\n\n';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models"))
        return Response.json({
          models: [
            {
              visibility: "list",
              slug: "authorized-model",
              display_name: "Authorized",
            },
          ],
        });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.input));
      assert.ok(!("max_tokens" in body));
      return new Response(stream);
    };
    assert.equal(
      await inference(active, "authorized-model", { question: "test" }),
      "test",
    );
    stream =
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    await assert.rejects(
      inference(active, "authorized-model", {}),
      /without response.completed/,
    );
    stream =
      'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n';
    await assert.rejects(
      inference(active, "authorized-model", {}),
      /subscription_sharing_usage_limit_exceeded/,
    );
    // Controlled provider failures, never live quota exhaustion or new authorization.
    for (const status of [401, 429]) {
      globalThis.fetch = async () => new Response(null, { status });
      await assert.rejects(
        inference(active, "authorized-model", {}),
        new RegExp(String(status)),
      );
    }
    for (const name of ["TimeoutError", "AbortError"]) {
      globalThis.fetch = async () => {
        throw new DOMException("Controlled provider interruption", name);
      };
      await assert.rejects(
        inference(active, "authorized-model", {}),
        /Controlled provider interruption/,
      );
    }
    let release!: () => void;
    const revocation = new Promise<void>((r) => {
      release = r;
    });
    let revoking = false;
    globalThis.fetch = async (input) => {
      if (String(input).includes("openid-configuration"))
        return Response.json({ revocation_endpoint: issuer + "/oauth/revoke" });
      revoking = true;
      await revocation;
      return new Response(null, { status: 200 });
    };
    const logout = signOut(active);
    while (!revoking) await new Promise((r) => setTimeout(r, 1));
    await saveSelection("client-b");
    activateProfile(
      profileFor({
        ...c,
        client_id: "client-b",
        subject: "person-b",
        label: "B",
      }),
    );
    release();
    assert.equal((await logout).revoked, true);
    assert.equal(await selectedAccount(), "client-b");
    assert.equal((await readAccount("client-a")).refresh_token, "");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PLAYGROUND_AI_ENABLED;
    delete process.env.PLAYGROUND_ALLOW_CREDENTIAL_STORAGE;
    delete process.env.PLAYGROUND_AUTH_DIR;
    delete process.env.PLAYGROUND_STATE_DIR;
  }
});
