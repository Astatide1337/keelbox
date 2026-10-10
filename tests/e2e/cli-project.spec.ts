import { test, expect } from "@playwright/test";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root =
  process.env.PLAYGROUND_STATE_DIR ??
  join(homedir(), ".local/state/kubernetes-learning-playground");
const selected = join(root, "project.json");
test("CLI import updates open UI and reload; invalid input does not replace project; active exercise stays isolated", async ({
  page,
}) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "waypoint-cli-"));
  let previous: Buffer | undefined;
  try {
    previous = await readFile(selected);
  } catch {}
  try {
    const config = JSON.parse(
      await readFile(join(root, "server.json"), "utf8"),
    );
    await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
    await page.goto("/");
    const file = join(dir, "service.yaml");
    await writeFile(
      file,
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: cli-service\n  namespace: cli-demo\nspec:\n  selector:\n    app: cli-demo\n",
    );
    await exec("pnpm", ["cli", "import", dir]);
    await expect(page.locator(".project-label")).toHaveText(
      dir.split("/").at(-1)!,
      { timeout: 10000 },
    );
    await expect(
      page.getByRole("button", { name: "Service cli-service", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Service cli-service", exact: true }),
    ).toBeVisible();
    const before = await readFile(selected, "utf8");
    await writeFile(file, "apiVersion: [");
    await expect(exec("pnpm", ["cli", "import", dir])).rejects.toThrow();
    expect(await readFile(selected, "utf8")).toBe(before);
    // Browser imports keep their selection until a new CLI revision arrives.
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page
      .getByLabel("Paste manifests or snapshot JSON")
      .fill(await readFile("examples/storefront/snapshot.json", "utf8"));
    await page.getByRole("button", { name: "Import pasted content" }).click();
    await page
      .getByRole("button", { name: "Service web", exact: true })
      .click();
    await page.getByRole("tab", { name: "YAML", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText("apiVersion: [");
    await writeFile(
      file,
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: draft-safe\n",
    );
    await exec("pnpm", ["cli", "import", dir]);
    await expect(
      page.getByRole("button", { name: "Open CLI project" }),
    ).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("apiVersion: [");
    await page.getByRole("button", { name: "Open CLI project" }).click();
    await expect(
      page.getByRole("button", { name: "Service draft-safe", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Resume draft: Storefront example",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Service web", exact: true })
      .click();
    await page.getByRole("tab", { name: "YAML", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("apiVersion: [");

    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page
      .getByLabel("Paste manifests or snapshot JSON")
      .fill(await readFile("examples/storefront/snapshot.json", "utf8"));
    await page.getByRole("button", { name: "Import pasted content" }).click();
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await page
      .getByRole("button", { name: "Begin investigation" })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Check repair" }),
    ).toBeVisible();
    const retainedExerciseId = new URL(page.url()).searchParams.get(
      "exercise",
    )!;
    await writeFile(
      file,
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: another-service\n  namespace: cli-demo\nspec:\n  selector:\n    app: cli-demo\n",
    );
    await exec("pnpm", ["cli", "import", dir]);
    await expect(
      page.getByRole("button", { name: "Open CLI project" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "A Pod fails its readiness probe" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open CLI project" }).click();
    await expect(
      page.getByRole("button", {
        name: "Service another-service",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Resources", exact: true }).click();
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "A Pod fails its readiness probe" }),
    ).toBeVisible();
    await expect(page.getByText("Attempt 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resources", exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("exercise"))
      .toBe(false);
    await expect
      .poll(async () => {
        try {
          return JSON.parse(
            await readFile(
              join(root, "exercises", retainedExerciseId + ".json"),
              "utf8",
            ),
          ).project.label;
        } catch {
          return "";
        }
      })
      .toBe(dir.split("/").at(-1)!);
    await expect
      .poll(() => new URL(page.url()).searchParams.has("exercise"))
      .toBe(false);
    await page.reload();
    await expect(page.locator(".project-label")).toHaveText(
      dir.split("/").at(-1)!,
    );
    await expect(
      page.getByRole("button", {
        name: "Service another-service",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    if (previous) await writeFile(selected, previous, { mode: 0o600 });
    else await rm(selected, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
