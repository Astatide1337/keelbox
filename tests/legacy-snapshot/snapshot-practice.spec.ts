import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
test.setTimeout(60000);
const evidence = "/tmp/waypoint-v3-evidence";
let snapshot: string;
const pageErrors = new Map<Page, string[]>();
const previousProject = new Map<Page, Buffer | undefined>();
const root =
  process.env.PLAYGROUND_STATE_DIR ??
  join(homedir(), ".local/state/kubernetes-learning-playground");
const selectedProject = join(root, "project.json");
test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  try {
    previousProject.set(page, await readFile(selectedProject));
  } catch {}
  await rm(selectedProject, { force: true });
  page.on("pageerror", (e) => pageErrors.get(page)!.push(e.message));
  snapshot = await readFile("examples/storefront/snapshot.json", "utf8");
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  await page.goto("/");
  await mkdir(evidence, { recursive: true });
  await expect(
    page.getByRole("heading", { name: "Topology", exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const prior = previousProject.get(page);
  if (prior) await writeFile(selectedProject, prior, { mode: 0o600 });
  else await rm(selectedProject, { force: true });
  expect(pageErrors.get(page)).toEqual([]);
});
async function importJson(page: Page, content: string) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Paste manifests or snapshot JSON").fill(content);
  await page.getByRole("button", { name: "Import pasted content" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function begin(page: Page, index: number) {
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page
    .getByRole("button", { name: "Begin investigation" })
    .nth(index)
    .click();
  await expect(
    page.getByRole("button", { name: "Check repair" }),
  ).toBeVisible();
}
test("import → explore → readiness investigate → semantic repair → reset → unchanged source, plus checkpoint recovery", async ({
  page,
}) => {
  await importJson(page, snapshot);
  await page.screenshot({ path: join(evidence, "topology.png") });
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "Origin", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await expect(
    page.getByText("Events unavailable or not captured"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manifest files", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Authored manifest files" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page.screenshot({ path: join(evidence, "catalog.png") });
  await page
    .getByRole("button", { name: "Begin investigation" })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Check repair" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pod web-example-1", exact: true })
    .click();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(
    page.getByText(
      "Readiness probe failed: HTTP probe failed with statuscode: 404",
    ),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, "readiness-events.png") });
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(page.getByText("Synthetic scenario logs")).toBeVisible();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await page.getByRole("button", { name: "Open owner manifest" }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await expect(editor).toBeVisible();
  const deployment = JSON.parse(snapshot).files.find((f: any) =>
    f.name.endsWith("deployment-web.yaml"),
  ).content;
  const fault = deployment.replace(
    "path: /healthz",
    "path: /practice-unavailable",
  );
  await editor.fill("apiVersion: [");
  await expect(page.locator('.inspector [role="alert"]')).toContainText(
    "Invalid YAML",
  );
  await expect(
    page.getByRole("button", { name: "Check repair" }),
  ).toBeDisabled();
  await page.screenshot({ path: join(evidence, "invalid-draft.png") });
  await editor.fill(
    fault.replace("path: /practice-unavailable", "path: /missing"),
  );
  await page.getByRole("button", { name: "Check repair" }).click();
  await expect(page.getByRole("status")).toContainText("preserving");
  await editor.fill(deployment.replace("replicas: 2", "replicas: 0"));
  await page.getByRole("button", { name: "Check repair" }).click();
  await expect(page.getByRole("status")).toContainText("preserving");
  await editor.fill(deployment);
  await page.getByRole("button", { name: "Check repair" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Passing the practice scenario",
  );
  await page.screenshot({ path: join(evidence, "readiness-success.png") });
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Check repair" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Passing the practice scenario · evidence, cause and repair",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByText("Attempt 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await page
    .getByRole("button", { name: "Deployment web", exact: true })
    .click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await editor.press("Control+End");
  await expect(editor).toContainText("path: /healthz");
  await expect(page.getByText(/Synthetic scenario/)).toHaveCount(0);
  await page.screenshot({ path: join(evidence, "source-unchanged.png") });
});
test("liveness and 503 are distinct complete incidents; switching does not leak edits or hints", async ({
  page,
}) => {
  await begin(page, 1);
  await page
    .getByRole("button", { name: "Pod web-example-1", exact: true })
    .click();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(
    page.getByText("Container failed liveness probe, will be restarted"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Request hint", exact: false })
    .click();
  await page.screenshot({ path: join(evidence, "liveness.png") });
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await page.getByRole("button", { name: "Open owner manifest" }).click();
  const deployment = JSON.parse(snapshot).files.find((f: any) =>
    f.name.endsWith("deployment-web.yaml"),
  ).content;
  await page
    .getByRole("textbox", { name: "YAML source editor" })
    .fill(deployment);
  await page.getByRole("button", { name: "Check repair" }).click();
  await expect(page.getByRole("status")).toContainText("Passing");
  await page.getByRole("button", { name: "Incidents", exact: true }).click();
  await page
    .getByRole("button", { name: "Begin investigation" })
    .nth(2)
    .click();
  await expect(page.getByText("Attempt 1", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Deployment gateway", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Request hint", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(page.getByText(/gateway: HTTP 503/)).toBeVisible();
  await page.screenshot({ path: join(evidence, "http503.png") });
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const service = JSON.parse(snapshot).files.find((f: any) =>
    f.name.endsWith("service.yaml"),
  ).content;
  await page.getByRole("textbox", { name: "YAML source editor" }).fill(service);
  await page.getByRole("button", { name: "Check repair" }).click();
  await expect(page.getByRole("status")).toContainText("Passing");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByText("Attempt 2", { exact: true })).toBeVisible();
});
test("incompatible/partial imports, explicit fallback, malformed imports, responsive and keyboard controls", async ({
  page,
}) => {
  const partial = JSON.parse(snapshot);
  partial.label = "Partial project";
  partial.contracts = [];
  partial.resources = partial.resources.filter((r: any) => r.kind !== "Pod");
  partial.coverage = [];
  await importJson(page, JSON.stringify(partial));
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page
    .getByRole("button", { name: "Review prerequisites" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "No supported healthy HTTP endpoint contract",
  );
  await page.getByRole("button", { name: "Keep project" }).click();
  await expect(page.locator(".project-label")).toHaveText("Partial project");
  await expect(
    page.getByRole("button", { name: /Use bundled example/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await expect(page.locator(".project-label")).toHaveText("Partial project");
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await expect(
    page.getByText("Unknown · EndpointSlices unavailable"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByLabel("Paste manifests or snapshot JSON")
    .fill("apiVersion: [");
  await page.getByRole("button", { name: "Import pasted content" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  const separator = page.getByRole("separator");
  await separator.focus();
  await separator.press("ArrowLeft");
  await page.screenshot({ path: join(evidence, "laptop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const showInspector = page.getByRole("button", {
    name: "Show inspector",
    exact: true,
  });
  if (await showInspector.isVisible()) await showInspector.click();
  await expect(page.locator(".primary-surface")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: join(evidence, "mobile.png") });
});
test("relationship evidence, layout retention, namespace scope and disconnected checkpoint storage", async ({
  page,
}) => {
  const node = page.locator(".react-flow__node").filter({
    has: page.getByRole("button", { name: "Deployment web", exact: true }),
  });
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + 28, { steps: 6 });
  await page.mouse.up();
  const moved = await node.evaluate((el) => getComputedStyle(el).transform);
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await expect(node).toHaveCSS("transform", moved);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("button", { name: /Relationship evidence/ }).click();
  await page
    .getByRole("button", { name: /spec.selector/ })
    .first()
    .click();
  await expect(page.locator(".source-highlight").first()).toBeVisible();
  const editor = page.locator(".cm-content");
  await editor.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const caret = () =>
    page.evaluate(() => {
      const s = window.getSelection();
      return { text: s?.anchorNode?.textContent, offset: s?.anchorOffset };
    });
  const beforeCaret = await caret();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await editor.focus();
  await expect.poll(caret).toEqual(beforeCaret);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByLabel("Paste manifests or snapshot JSON")
    .fill(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: empty\n  namespace: other\nspec:\n  selector:\n    app: empty\n",
    );
  await page.getByRole("button", { name: "Import pasted content" }).click();
  await page.getByRole("combobox", { name: "Namespace" }).click();
  await page.getByRole("option", { name: "other", exact: true }).click();
  await page
    .getByRole("button", { name: "Service empty", exact: true })
    .click();
  await expect(page.locator(".inspector-heading")).toContainText("other");
  await expect(
    page.getByText("Unknown · EndpointSlices unavailable"),
  ).toBeVisible();
  await page.route("**/api/practice", (route) => route.abort());
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Paste manifests or snapshot JSON").fill(snapshot);
  await page.getByRole("button", { name: "Import pasted content" }).click();
  await begin(page, 0);
  await expect(
    page.getByLabel(/Progress not saved: Checkpoint unavailable:/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check repair" }),
  ).toBeEnabled();
  await page.screenshot({ path: join(evidence, "checkpoint-unavailable.png") });
});
