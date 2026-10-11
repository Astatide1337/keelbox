import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test.use({ trace: "off" });
test("installed signed-in source UI: save/revert, invalid draft, export, reload, same-file retry and narrow keyboard navigation", async ({
  page,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  test.skip(
    process.env.WAYPOINT_REAL_SOURCE !== "1",
    "Requires explicit own installed UI and restored consent.",
  );
  const cli = process.env.WAYPOINT_E2E_CLI!,
    fixture = process.env.WAYPOINT_E2E_FIXTURE!;
  if (!cli || !fixture) throw Error("Set installed CLI and fixture.");
  await exec(cli, ["import", fixture], { env: process.env });
  const ticket = (
    await readFile(process.env.WAYPOINT_E2E_CONNECT_LOG!, "utf8")
  ).match(/\?connect=([a-f0-9]{64})/)?.[1];
  if (!ticket) throw Error("Fresh owned connect link required.");
  await page.goto("/?connect=" + ticket);
  await expect(page.locator(".project-label")).toHaveText("local-http");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("workspace"))
    .toMatch(/:[a-f0-9-]{36}$/);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  const original = await readFile(join(fixture, "application.yaml"), "utf8");
  const changed = original + "\n# audit-saved-analysis-draft\n";
  await editor.fill(changed);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Analysis draft saved locally.", { exact: false }),
  ).toBeVisible();
  await editor.fill("spec: [");
  await expect(
    page.getByText("Previous graph · source invalid", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(editor).toContainText("audit-saved-analysis-draft");
  await page
    .getByRole("button", { name: "Manifest files", exact: true })
    .click();
  await editor.fill("");
  await expect(editor).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(editor).toContainText("audit-saved-analysis-draft");
  const draftDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft", exact: true }).click();
  const draft = JSON.parse(
    await readFile((await (await draftDownload).path())!, "utf8"),
  );
  expect(JSON.stringify(draft.files)).toContain("audit-saved-analysis-draft");
  expect(draft.resources).toEqual([]);
  await page.getByRole("button", { name: "local-http", exact: true }).click();
  const sourceDownload = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Export source", exact: true })
    .click();
  const source = JSON.parse(
    await readFile((await (await sourceDownload).path())!, "utf8"),
  );
  expect(JSON.stringify(source)).not.toContain("audit-saved-analysis-draft");
  const restorableUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(restorableUrl);
  await expect(editor).toContainText("audit-saved-analysis-draft");
  await expect(page.locator(".project-label")).toHaveText("local-http");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("workspace"))
    .toMatch(/:[a-f0-9-]{36}$/);
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await editor.press("Control+End");
  await expect(editor).toContainText("audit-saved-analysis-draft");
  await page.screenshot({
    path: test.info().outputPath("source-draft-laptop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Project files");
  await input.setInputFiles({
    name: "retry.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(""),
  });
  await expect(dialog.getByRole("alert")).toContainText("Choose a file");
  await input.setInputFiles({
    name: "retry.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from("spec: ["),
  });
  await expect(dialog.getByRole("alert")).toContainText("Line");
  await input.setInputFiles({
    name: "retry.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(
      "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: retry, namespace: test}\ndata: {example: safe}\n",
    ),
  });
  await expect(
    dialog.getByRole("button", { name: "Confirm import", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.locator(".project-label")).not.toHaveText("local-http");
  await expect(
    page.getByRole("button", { name: "ConfigMap retry", exact: true }),
  ).toBeVisible();
  const auth = await (await page.request.get("/api/auth")).json();
  const selectedResponse = await page.request.get("/api/project", {
    headers: {
      "X-Waypoint-Profile": auth.profile.key,
      "X-Waypoint-Epoch": String(auth.epoch),
    },
  });
  expect(selectedResponse.ok()).toBe(true);
  const selected = (await selectedResponse.json()).selected.project;
  expect(selected.files).toHaveLength(1);
  expect(selected.files[0].name).toBe("retry.yaml");
  expect(selected.files[0].content).toContain("name: retry");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  const row = page.getByRole("button", { name: "retry", exact: true });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "retry", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Overview", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("source-mobile-inspector.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect(await readFile(join(fixture, "application.yaml"), "utf8")).toBe(
    original,
  );
});
