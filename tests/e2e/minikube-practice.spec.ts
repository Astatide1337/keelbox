import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
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
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  await exec(cli, ["import", fixture], { env: process.env });
  await page.goto("/");
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
  await page.setExtraHTTPHeaders({
    Authorization: "Bearer " + config.token,
    "X-Waypoint-Profile": auth.profile.key,
    "X-Waypoint-Epoch": String(auth.epoch),
  });
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
    .poll(async () => (await call()).lab?.phase, { timeout: 20000 })
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
  await page.screenshot({
    path: join(test.info().outputDir, "readiness-incident.png"),
    fullPage: true,
  });
  const pods = page
    .getByRole("navigation", { name: "Application resource tree" })
    .getByRole("button", { name: /^Pod \/ web-/ });
  await pods.first().click();
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
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.fill("spec: [");
  await expect(
    page.getByText("Draft retained; previous graph unchanged.", {
      exact: false,
    }),
  ).toBeVisible();
  const lab = (await call()).lab;
  await editor.fill(lab.plan.source);
  await page.getByRole("button", { name: "Apply repair", exact: true }).click();
  await expect
    .poll(async () => (await call()).lab.operation, { timeout: 180000 })
    .toBeNull();
  await expect(
    page.getByRole("button", { name: "Check recovery", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Check recovery", exact: true })
    .click();
  await expect(
    page.getByText("Recovery verified in the owned cluster.", { exact: false }),
  ).toBeVisible({ timeout: 180000 });
  await page.screenshot({
    path: join(test.info().outputDir, "readiness-success.png"),
    fullPage: true,
  });
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "Reset baseline", exact: true })
      .click();
    await expect(start).toBeEnabled({ timeout: 180000 });
  }
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
  await expect(
    page.getByRole("button", { name: "Review deployment" }),
  ).toBeVisible({ timeout: 180000 });
});
