import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
const root =
  process.env.PLAYGROUND_STATE_DIR ??
  join(homedir(), ".local/state/kubernetes-learning-playground");
test("development account dialog stays AI-off and has no inference controls", async ({
  page,
}) => {
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open account" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("controlled auth boundary: failed consent keeps host draft; epoch switches restore each profile's malformed draft", async ({
  page,
}) => {
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  // UI ownership regression only. Real consent/inference are verified separately against OpenAI.
  let status = {
    enabled: true,
    profile: {
      kind: "chatgpt",
      key: "a".repeat(64),
      label: "Fixture account A",
    },
    epoch: "epoch-a",
    csrf: "fixture-csrf",
    accounts: [],
    issues: [],
    planEnabled: true,
    needsWelcome: false,
  };
  await page.route("**/api/auth", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({ json: status });
    else
      await route.fulfill({
        json: {
          attemptId: "00000000-0000-4000-8000-000000000001",
          url: config.origin + "/auth/openai?ticket=controlled-test",
        },
      });
  });
  await page.route("**/api/auth?attempt=*", (route) =>
    route.fulfill({
      json: { state: "failed", error: "Controlled declined consent" },
    }),
  );
  await page.route("**/api/project", (route) =>
    route.fulfill({ json: { selected: null } }),
  );
  await page.context().route("**/auth/openai?ticket=controlled-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Controlled external consent boundary</p>",
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await editor.fill("apiVersion: [\n# profile-a-draft");
  await page.getByRole("button", { name: "Open account" }).click();
  const popup = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Change account", exact: true })
    .click();
  await popup;
  await expect(page.getByRole("dialog")).toContainText(
    "Controlled declined consent",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).toContainText("profile-a-draft");
  status = {
    ...status,
    profile: {
      kind: "chatgpt",
      key: "b".repeat(64),
      label: "Fixture account B",
    },
    epoch: "epoch-b",
  };
  await expect(
    page.getByRole("button", { name: "Service web", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(2300);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(editor).not.toContainText("profile-a-draft");
  await editor.fill("apiVersion: [\n# profile-b-draft");
  status = {
    ...status,
    profile: {
      kind: "chatgpt",
      key: "a".repeat(64),
      label: "Fixture account A",
    },
    epoch: "epoch-a-return",
  };
  await page.waitForTimeout(2300);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(editor).toContainText("profile-a-draft");
  await expect(editor).not.toContainText("profile-b-draft");
});
test("controlled inference failure retains question and reviewed evidence without showing a successful answer", async ({
  page,
}) => {
  const config = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
  await page.setExtraHTTPHeaders({ Authorization: "Bearer " + config.token });
  await page.route("**/api/auth", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        profile: {
          kind: "chatgpt",
          key: "a".repeat(64),
          label: "Fixture account",
        },
        epoch: "controlled",
        csrf: "controlled",
        accounts: [],
        issues: [],
        planEnabled: true,
        needsWelcome: false,
      },
    }),
  );
  await page.route("**/api/auth?models=1", (route) =>
    route.fulfill({
      json: { models: [{ id: "fixture-model", name: "Fixture model" }] },
    }),
  );
  await page.route("**/api/project", (route) =>
    route.fulfill({
      json:
        route.request().method() === "POST"
          ? { selected: { revision: "00000000-0000-4000-8000-000000000002" } }
          : { selected: null },
    }),
  );
  await page.route("**/api/tutor", (route) => {
    const input = route.request().postDataJSON();
    return route.fulfill(
      input.kind === "preview"
        ? {
            json: {
              question: input.question,
              digest: "a".repeat(64),
              context: { evidence: [] },
            },
          }
        : {
            status: 400,
            json: {
              error:
                "ChatGPT request failed: subscription_sharing_usage_limit_exceeded. Manage usage or reconnect.",
            },
          },
    );
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Storefront example", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Ask about this project" }).click();
  const q = page.getByRole("textbox", {
    name: "Question about Kubernetes evidence",
  });
  await q.fill("Explain this project with the supplied evidence.");
  await page.getByRole("button", { name: "Review request" }).click();
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "subscription_sharing_usage_limit_exceeded",
  );
  await expect(q).toHaveValue(
    "Explain this project with the supplied evidence.",
  );
  await expect(page.getByLabel("AI explanation")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeEnabled();
});
