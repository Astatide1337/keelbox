import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test.use({ trace: "off" }); // Live auth/session capabilities must not enter exported traces.
test("installed CLI → real readiness evidence → repair → check → reset → unchanged source", async ({
  page,
}) => {
  test.skip(
    process.env.WAYPOINT_REAL_LAB !== "1",
    "Explicit opt-in creates and cleans a dedicated owned Minikube cluster.",
  );
  test.setTimeout(900000);
  const root = process.env.PLAYGROUND_STATE_DIR;
  if (!root) throw Error("Use an app-private PLAYGROUND_STATE_DIR.");
  const cli = process.env.WAYPOINT_E2E_CLI;
  if (!cli)
    throw Error("Set WAYPOINT_E2E_CLI to the installed tarball executable.");
  const fixture = process.env.WAYPOINT_E2E_FIXTURE;
  if (!fixture)
    throw Error(
      "Set WAYPOINT_E2E_FIXTURE to the installed local-http directory.",
    );
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  const original = await readFile(join(fixture, "application.yaml"), "utf8");
  const log = process.env.WAYPOINT_E2E_CONNECT_LOG;
  if (!log)
    throw Error(
      "Set WAYPOINT_E2E_CONNECT_LOG to this owned server startup log; browser connection must use its real one-time link.",
    );
  const ticket = (await readFile(log, "utf8")).match(
    /\?connect=([a-f0-9]{64})/,
  )?.[1];
  if (!ticket) throw Error("Owned startup connection link unavailable.");
  await exec(cli, ["import", fixture], { env: process.env });
  await page.goto("/?connect=" + ticket);
  await expect(page.locator(".project-label")).toHaveText("local-http");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const call = async (body?: Record<string, unknown>) => {
    const r = await page.request.fetch("/api/lab", {
      method: body ? "POST" : "GET",
      headers: {
        Origin: config.origin,
        Authorization: "Bearer " + config.token,
        "X-Waypoint-Profile": auth.profile.key,
        "X-Waypoint-Epoch": String(auth.epoch),
      },
      data: body,
    });
    const d = await r.json();
    if (!r.ok()) throw Error(d.error);
    return d;
  };
  const authResponse = await page.request.get("/api/auth", {
    headers: { Authorization: "Bearer " + config.token },
  });
  const auth = await authResponse.json();
  expect(
    (await page.context().cookies()).map(({ name, httpOnly, sameSite }) => ({
      name,
      httpOnly,
      sameSite,
    })),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "playground",
        httpOnly: true,
        sameSite: "Strict",
      }),
    ]),
  );
  const initial = await call();
  expect(!initial.lab || initial.lab.phase === "stopped").toBeTruthy();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page.getByRole("button", { name: "Review deployment" }).click();
  if (process.env.WAYPOINT_E2E_LOCAL_IMAGE === "1") {
    await page
      .getByRole("textbox", { name: "Local Docker image tag" })
      .fill("nginx:1.28-alpine");
    await page
      .getByRole("button", { name: "Use local image", exact: true })
      .click();
    await expect(
      page.getByText("pull policy Never", { exact: false }).first(),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Create local lab" }).click();
  await expect
    .poll(async () => (await call()).lab?.phase, { timeout: 60000 })
    .toMatch(/^(preparing|ready)$/);
  const start = page.getByRole("button", {
    name: "Start readiness investigation",
  });
  await expect(start).toBeEnabled({ timeout: 600000 });
  await start.click();
  await expect(page.locator(".lab-checks")).toContainText(
    "Actual incident evidence",
    { timeout: 180000 },
  );
  const readinessNotebook = page.getByRole("button", {
    name: "Investigation notebook",
    exact: false,
  });
  await readinessNotebook.click();
  await page
    .getByRole("textbox", { name: "Investigation hypothesis" })
    .fill("The process runs but its readiness contract fails.");
  await page
    .getByRole("textbox", { name: "Investigation prediction" })
    .fill(
      "Expect Ready False, kubelet probe evidence and excluded ready backends.",
    );
  await page
    .getByRole("button", { name: "Request hint 1", exact: true })
    .click();
  await expect(page.getByText("Hint 1:", { exact: false })).toBeVisible();
  const initialCheckResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/lab") &&
      r.request().method() === "POST" &&
      r.request().postDataJSON()?.kind === "check",
  );
  await page
    .getByRole("button", { name: "Check recovery", exact: true })
    .click();
  expect((await initialCheckResponse).status()).toBe(202);
  await expect
    .poll(async () => (await call()).lab.operation, { timeout: 180000 })
    .toBeNull();
  expect((await call()).lab.phase).toBe("running");
  expect(
    (await call()).lab.checks.some(
      (check: { passed: boolean }) => !check.passed,
    ),
  ).toBe(true);
  await page
    .getByRole("textbox", { name: "Evidence interpretation" })
    .fill(
      "Observed conditions and fresh kubelet events corroborate the hypothesis; check does not award completion.",
    );
  await page.reload();
  await expect(readinessNotebook).toBeVisible();
  if ((await readinessNotebook.getAttribute("aria-expanded")) === "false")
    await readinessNotebook.click();
  await expect(
    page.getByRole("textbox", { name: "Investigation hypothesis" }),
  ).toHaveValue("The process runs but its readiness contract fails.");
  await expect(
    page.getByRole("textbox", { name: "Evidence interpretation" }),
  ).toHaveValue(/corroborate/);
  await expect(page.getByText("Hint 1:", { exact: false })).toBeVisible();
  await readinessNotebook.click();
  await page.screenshot({
    path: join(test.info().outputDir, "readiness-incident.png"),
    fullPage: true,
  });
  const pods = page
    .getByRole("navigation", { name: "Application resource tree" })
    .getByRole("button", { name: /· Pod \/ web-/ });
  await pods.first().click();
  if (process.env.WAYPOINT_REAL_AI === "1") {
    await page.getByRole("button", { name: "local-http", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Ask about this lab", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "Question about Kubernetes evidence" })
      .fill(
        "Explain the difference between Running and Ready using the selected Pod and Service evidence. Give one investigation hint, without revealing a repair or awarding completion. Cite the evidence IDs.",
      );
    const previewResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/tutor") &&
        r.request().postDataJSON()?.kind === "preview",
    );
    await dialog
      .getByRole("button", { name: "Review request", exact: true })
      .click();
    const preview = await (await previewResponse).json();
    expect(preview.context.project.live).toBe(true);
    expect(preview.context.evidence.length).toBeGreaterThan(0);
    expect(preview.context.evidence[0].resourceId).not.toBe("[redacted]");
    const answerResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/tutor") &&
        r.request().postDataJSON()?.kind === "ask",
      { timeout: 180000 },
    );
    await dialog
      .getByRole("button", { name: "Send question", exact: true })
      .click();
    const answer = await (await answerResponse).json();
    expect(answer.error).toBeUndefined();
    expect(answer.text).toMatch(/\[E\d+\]/);
    await expect(dialog.getByLabel("AI explanation")).toBeVisible();
    expect((await call()).lab.phase).toBe("running");
    await writeFile(
      join(test.info().outputDir, "real-inference.json"),
      JSON.stringify(
        {
          provider: "official SIWC restored prior consent",
          transport: "Responses store:false stream:true",
          preview,
          answer,
        },
        null,
        2,
      ),
    );
    await page.screenshot({
      path: join(test.info().outputDir, "real-inference.png"),
      fullPage: true,
    });
    const cited = preview.context.evidence.find(
      (e: { kind: string; name: string }) =>
        e.kind === "Service" && e.name === "web",
    );
    expect(cited).toBeDefined();
    await dialog
      .getByRole("button", {
        name: `Open ${cited.kind} ${cited.name} evidence`,
        exact: true,
      })
      .first()
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".live-inspector h2")).toHaveText(
      "Service / web",
    );
    await pods.first().click();
  }
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(
    page.getByText("Readiness probe failed:", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(page.locator(".live-log")).toContainText("/waypoint-missing-", {
    timeout: 30000,
  });
  await page.screenshot({
    path: join(test.info().outputDir, "readiness-logs.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Manifest files", exact: true })
    .click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.fill("spec: [");
  await expect(
    page.getByText("Draft retained; previous graph unchanged.", {
      exact: false,
    }),
  ).toBeVisible();
  const lab = (await call()).lab;
  await editor.fill(lab.plan.source);
  await page.screenshot({
    path: join(test.info().outputDir, "readiness-manifest-repair.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Apply repair", exact: true }).click();
  await expect
    .poll(async () => (await call()).lab.operation, { timeout: 180000 })
    .toBeNull();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page
    .getByRole("button", { name: "Investigation notebook", exact: false })
    .click();
  await expect(
    page.getByRole("button", { name: "Check recovery", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Check recovery", exact: true })
    .click();
  await expect(
    page.getByText("Explain the recovery", { exact: true }),
  ).toBeVisible({ timeout: 180000 });
  await page.screenshot({
    path: join(test.info().outputDir, "readiness-success.png"),
    fullPage: true,
  });
  await expect(
    page.getByText("Explain the recovery", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Recovery teach-back" })
    .fill(
      "The process was Running but the readiness path returned an error. Fixing the probe restored ready EndpointSlices and the in-cluster Service check.",
    );
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "Reset baseline", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm reset", exact: true })
      .click();
    await expect(start).toBeEnabled({ timeout: 180000 });
  }
  await page
    .getByRole("button", { name: "Start liveness investigation", exact: true })
    .click();
  await expect(page.locator(".lab-checks")).toContainText(
    "Actual incident evidence",
    { timeout: 180000 },
  );
  const liveness = (await call()).lab;
  expect(liveness.incidentObservedAt).toBeTruthy();
  await pods.first().click();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(
    page.getByText("Liveness probe failed:", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: join(test.info().outputDir, "liveness-incident.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await page
    .getByRole("button", { name: "Show previous container logs", exact: true })
    .click();
  await expect(page.locator(".live-log")).toContainText("nginx", {
    timeout: 30000,
  });
  await page.screenshot({
    path: join(test.info().outputDir, "liveness-previous-logs.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await editor.fill(liveness.plan.source);
  await page.getByRole("button", { name: "Apply repair", exact: true }).click();
  await expect
    .poll(async () => (await call()).lab.operation, { timeout: 180000 })
    .toBeNull();
  const notebook = page.getByRole("button", {
    name: "Investigation notebook",
    exact: false,
  });
  if ((await notebook.getAttribute("aria-expanded")) === "false")
    await notebook.click();
  await page
    .getByRole("button", { name: "Check recovery", exact: true })
    .click();
  await expect(
    page.getByText("Explain the recovery", { exact: true }),
  ).toBeVisible({ timeout: 180000 });
  await page.screenshot({
    path: join(test.info().outputDir, "liveness-success.png"),
    fullPage: true,
  });
  await writeFile(
    join(test.info().outputDir, "liveness-checks.json"),
    JSON.stringify(
      await (async () => {
        const completed = (await call()).lab;
        return {
          sessionId: completed.id,
          phase: completed.phase,
          generation: completed.generation,
          revision: completed.revision,
          incidentObservedAt: completed.incidentObservedAt,
          checks: completed.checks,
          connection: completed.evidence.connection,
          resources: completed.evidence.resources.map(
            (r: Record<string, any>) => ({
              kind: r.kind,
              metadata: {
                name: r.metadata?.name,
                namespace: r.metadata?.namespace,
                uid: r.metadata?.uid,
                ownerReferences: r.metadata?.ownerReferences,
              },
              status: r.status,
            }),
          ),
        };
      })(),
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await page.getByRole("button", { name: "Local lab" }).click();
  await page
    .getByRole("menuitem", { name: "Imported source", exact: true })
    .click();
  expect(await readFile(join(fixture, "application.yaml"), "utf8")).toBe(
    original,
  );
  await expect(
    page.getByRole("button", { name: "Service web", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page.getByRole("button", { name: "Clean up lab", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm cleanup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review deployment" }),
  ).toBeVisible({ timeout: 180000 });
});
