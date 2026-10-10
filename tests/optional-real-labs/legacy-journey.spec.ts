import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fixtureSource } from "../../lib/domain/scenarios";
const evidence =
  process.env.PLAYGROUND_EVIDENCE_DIR ?? "/tmp/playground-app-evidence";
test.beforeEach(async ({ page }) => {
  const config = JSON.parse(
    await readFile(
      join(
        homedir(),
        ".local/state/kubernetes-learning-playground/server.json",
      ),
      "utf8",
    ),
  );
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  await page.goto("/");
  await expect(
    page.getByText("Local session connected", { exact: true }),
  ).toBeVisible();
  await mkdir(evidence, { recursive: true });
});
test("browser exploration preserves invalid drafts, supports source evidence and development mode", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Import manifests", exact: true })
    .click();
  await page
    .getByLabel("Or paste multi-document YAML")
    .fill(fixtureSource("service-selector"));
  await page.getByRole("button", { name: "Explore source" }).click();
  await page.locator(".relationship-list summary").click();
  await page.locator(".relationship-rows button").first().click();
  await expect(page.locator(".evidence-links button")).toHaveCount(2);
  const node = page.locator(".react-flow__node").first();
  const initialTransform = await node.getAttribute("style");
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await editor.fill("spec: [");
  await expect(page.getByText("Invalid · graph retained")).toBeVisible();
  await expect(editor).toContainText("spec: [");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  expect(await node.getAttribute("style")).toBe(initialTransform);
  await page.screenshot({ path: join(evidence, "invalid-yaml.png") });
  await editor.fill(fixtureSource("service-selector"));
  await expect(page.locator(".syntax-error")).toHaveCount(0);
  await expect(page.getByText("Draft edited", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Development mode", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("separator", { name: "Resize source panel" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("separator")).toHaveAttribute(
    "aria-valuenow",
    "440",
  );
  await page
    .getByRole("button", { name: "Collapse resource navigator" })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand resource navigator" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand resource navigator" }).click();
  await page.screenshot({ path: join(evidence, "laptop-explore.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Source & inspector" }).click();
  await expect(editor).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: join(evidence, "mobile-source.png"),
    fullPage: true,
  });
});
test("real kind Service lesson: start → diagnose → repair → verify → reset → stop", async ({
  page,
}) => {
  await page.getByLabel("Practice a lesson").selectOption("service-selector");
  await page.getByRole("button", { name: "Start local lab" }).click();
  await expect(page.locator(".state-badge")).toHaveText("running", {
    timeout: 300000,
  });
  await expect(
    page.getByRole("button", { name: "Apply repair" }),
  ).toBeEnabled();
  await page.screenshot({ path: join(evidence, "lab-fault.png") });
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByRole("button", { name: "Fetch events" }).click();
  await expect(page.locator(".inspection-body pre")).not.toContainText(
    "No data fetched.",
  );
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("button", { name: "Get a hint" }).click();
  await expect(page.getByText("Authored lesson hint 1/3")).toBeVisible();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  const original = await editor.innerText();
  await editor.fill(original.replace("app: storefront", "app: web"));
  await page.getByRole("button", { name: "Apply repair" }).click();
  await expect(page.locator(".state-badge")).toHaveText("running");
  await expect(
    page.getByRole("button", { name: "Verify", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".state-badge")).toHaveText("completed", {
    timeout: 160000,
  });
  await expect(page.getByText("Repair proven", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "HTTP through Service DNS/port returned the expected lesson body.",
    ),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, "lab-completed.png") });
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator(".state-badge")).toHaveText("running", {
      timeout: 160000,
    });
    await expect(editor).toContainText("app: storefront");
  }
  await page.getByRole("button", { name: "Stop owned lab" }).click();
  await expect(
    page.getByRole("button", { name: "Start local lab" }),
  ).toBeEnabled({ timeout: 150000 });
});
