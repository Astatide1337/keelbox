import { test, expect } from "@playwright/test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const root =
  process.env.PLAYGROUND_STATE_DIR ??
  join(homedir(), ".local/state/kubernetes-learning-playground");
let previous: Buffer | undefined;
test.beforeEach(async ({ page }) => {
  try {
    previous = await readFile(join(root, "project.json"));
  } catch {
    previous = undefined;
  }
  await rm(join(root, "project.json"), { force: true });
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Topology", exact: true }),
  ).toBeVisible();
});
test.afterEach(async () => {
  if (previous)
    await writeFile(join(root, "project.json"), previous, { mode: 0o600 });
  else await rm(join(root, "project.json"), { force: true });
});
test("component shell, selection/filter isolation, real saved catalog and original-source resume", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("button", { name: "Pod web-example-1", exact: true })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(4);
  await page.getByRole("combobox", { name: "Resource kind" }).click();
  await page.getByRole("option", { name: "Pod", exact: true }).click();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(page.locator(".inspector-heading")).toContainText(
    "web-example-1",
  );
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page.getByLabel("Find an incident").fill("readiness");
  await expect(page.locator(".incident")).toHaveCount(1);
  await page.getByLabel("Find an incident").fill("nothing matches");
  await expect(page.getByText("No incidents match")).toBeVisible();
  await page.getByLabel("Find an incident").fill("");
  await page.getByRole("combobox", { name: "Incident level" }).click();
  await page.getByRole("option", { name: "Beginner", exact: true }).click();
  await expect(page.locator(".incident")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Begin investigation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Deployment web", exact: true }),
  ).toBeVisible();
  const exerciseId = new URL(page.url()).searchParams.get("exercise")!;
  await page
    .getByRole("button", { name: "Deployment web", exact: true })
    .click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await editor.fill("apiVersion: [");
  await expect(page.locator(".inspector [role=alert]")).toContainText(
    "Invalid YAML",
  );
  await page.getByRole("button", { name: "Incidents", exact: true }).click();
  const row = page.locator(".history-table tr").filter({
    has: page.getByRole("button", {
      name: new RegExp(exerciseId.slice(0, 8)),
    }),
  });
  await expect(row).toContainText("Storefront example");
  // Change selected exploration project. Resume must keep the exercise's original source, not use this project.
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .getByLabel("Paste manifests or snapshot JSON")
    .fill(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: new-project\n  namespace: other\nspec:\n  selector:\n    app: elsewhere\n",
    );
  await page.getByRole("button", { name: "Import pasted content" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(exerciseId.slice(0, 8)) })
    .click();
  await expect(
    page.getByRole("button", { name: "Deployment web", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Deployment web", exact: true })
    .click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(editor).toContainText("apiVersion: [");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByText("Attempt 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Service new-project", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("dark menus, mobile sheet focus and laptop/200% layout, actual empty and unavailable history states", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "Show minimap" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByRole("button", { name: "Show minimap" }).click();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(1);
  await page.getByRole("button", { name: "Hide minimap" }).click();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByRole("button", { name: "Application settings" }).click();
  await expect(page.getByRole("menu")).toContainText("Switch to light theme");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Application settings" }),
  ).toBeFocused();
  await page.setViewportSize({ width: 683, height: 384 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Practice", exact: true }),
  ).toBeVisible();
  await page.route("**/api/practice?list=1", (route) => route.abort());
  await page.reload();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(
    page.getByText(/Saved investigations unavailable/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Application settings" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/waypoint-ui-plan-GW4jLG/implementation-mobile-practice.png",
    fullPage: true,
  });
});

test("theme switch preserves editor draft, graph selection and viewport; captured ownership fields retain precise source highlighting", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "ReplicaSet web-example", exact: true })
    .click();
  await page.getByRole("button", { name: /Relationship evidence/ }).click();
  await page
    .getByRole("button", { name: /metadata.ownerReferences/ })
    .first()
    .click();
  await expect(
    page.getByRole("tab", { name: "YAML", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(page.locator(".source-highlight").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Deployment web", exact: true })
    .click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await editor.fill("apiVersion: [");
  const transform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.getByRole("button", { name: "Application settings" }).click();
  await page.getByRole("menuitem", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(editor).toContainText("apiVersion: [");
  await expect(page.locator(".inspector-heading")).toContainText("web");
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    transform!,
  );
  await page.screenshot({
    path: "/tmp/waypoint-ui-plan-GW4jLG/implementation-light.png",
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Application settings" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
