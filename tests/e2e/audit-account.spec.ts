import { test, expect } from "@playwright/test";
import example from "../../examples/storefront/snapshot.json";
import { importSnapshot, snapshotDigest } from "../../lib/domain/snapshot";
import { deploymentPlan } from "../../lib/domain/deployment-plan";

// Controlled UI regressions only: auth, projects, lab state and AI are MOCKS.
// This test never reads credentials, calls OpenAI, or creates/mutates a cluster.
const A = "a".repeat(64),
  B = "b".repeat(64);
const revision = "00000000-0000-4000-8000-000000000011";
const projectA = importSnapshot(
  JSON.stringify({
    ...example,
    id: "mock-account-a-project",
    label: "Account A imported project",
    files: example.files.map((file) => ({
      ...file,
      content: file.content + "\n# account-a-original-file\n",
    })),
  }),
);
function status(key: string) {
  return {
    enabled: true,
    profile: {
      kind: "chatgpt",
      key,
      label: key === A ? "Mock account A" : "Mock account B",
    },
    epoch: "same-epoch-for-isolation-regression",
    csrf: "mock-csrf",
    accounts: [],
    issues: [],
    planEnabled: true,
    needsWelcome: false,
  };
}
async function mockCommon(
  page: import("@playwright/test").Page,
  account: () => string,
) {
  await page.route("**/api/auth", (route) =>
    route.fulfill({ json: status(account()) }),
  );
  await page.route("**/api/auth?models=1", (route) =>
    route.fulfill({
      json: { models: [{ id: "mock-model", name: "Mock model" }] },
    }),
  );
  await page.route("**/api/configuration", (route) =>
    route.fulfill({ json: { secrets: [], vault: { entries: [] } } }),
  );
}

test("MOCK UI: same-epoch account switch isolates recent projects and malformed drafts", async ({
  page,
}) => {
  let active = A;
  await page.addInitScript(() => {
    const captured: { key: string; value: string }[] = [];
    (
      window as unknown as { auditStorageWrites: typeof captured }
    ).auditStorageWrites = captured;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("waypoint:analysis:") ||
        key.startsWith("waypoint:projects:")
      )
        captured.push({ key, value });
      return original.call(this, key, value);
    };
  });
  const writes: { profile: string | undefined; project: unknown }[] = [];
  await mockCommon(page, () => active);
  await page.route("**/api/project", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      writes.push({
        profile: request.headers()["x-waypoint-profile"],
        project: body.project,
      });
      return route.fulfill({
        json: { selected: { revision, project: body.project } },
      });
    }
    return route.fulfill({
      json: { selected: active === A ? { revision, project: projectA } : null },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => new URL(location.href).searchParams.get("workspace")),
    )
    .toBe(A + ":" + projectA.id);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await editor.fill("apiVersion: [\n# account-a-only-malformed-draft");
  await expect(editor).toContainText("account-a-only-malformed-draft");
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem("waypoint:projects:v1:" + key),
        A,
      ),
    )
    .toContain("mock-account-a-project");
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          Object.entries(localStorage).some(
            ([name, value]) =>
              name.startsWith("waypoint:analysis:") &&
              name.includes(key) &&
              value.includes("account-a-only-malformed-draft"),
          ),
        A,
      ),
    )
    .toBe(true);
  active = B;
  await expect(
    page.getByRole("button", { name: "Storefront example", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(editor).not.toContainText("account-a-only-malformed-draft");
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem("waypoint:projects:v1:" + key),
        B,
      ),
    )
    .toContain("bundled-storefront-v1");
  const bStorage = await page.evaluate(
    (key) =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([name]) => name.includes(key)),
      ),
    B,
  );
  const serialized = JSON.stringify(bStorage);
  expect(serialized).not.toContain("mock-account-a-project");
  expect(serialized).not.toContain("account-a-only-malformed-draft");
  expect(serialized).not.toContain("account-a-original-file");
  const allBWrites = await page.evaluate(
    (key) =>
      (
        window as unknown as {
          auditStorageWrites: { key: string; value: string }[];
        }
      ).auditStorageWrites.filter((write) => write.key.includes(key)),
    B,
  );
  expect(allBWrites.length).toBeGreaterThan(0);
  for (const marker of [
    "mock-account-a-project",
    "account-a-only-malformed-draft",
    "account-a-original-file",
  ])
    expect(JSON.stringify(allBWrites)).not.toContain(marker);
  expect(
    writes
      .filter((write) => write.profile === B)
      .map((write) => JSON.stringify(write.project))
      .join("\n"),
  ).not.toContain("mock-account-a-project");
  active = A;
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => new URL(location.href).searchParams.get("workspace")),
    )
    .toBe(A + ":" + projectA.id);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(editor).toContainText("account-a-only-malformed-draft");
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("mock-account-isolation.png"),
    fullPage: true,
  });
});

test("MOCK UI: global Ask uses live scope then source scope on Secrets / Vault", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  await page.route("**/api/project", (route) =>
    route.fulfill({ json: { selected: { revision, project: projectA } } }),
  );
  const plan = deploymentPlan(projectA, "waypoint-lab-123456789abc");
  const labId = "00000000-0000-4000-8000-000000000099";
  await page.route("**/api/lab", (route) => {
    const receivedAt = new Date().toISOString();
    return route.fulfill({
      json: {
        plan: null,
        lab: {
          id: labId,
          generation: 2,
          revision: 7,
          phase: "ready",
          namespace: plan.namespace,
          plan,
          source: plan.source,
          incident: null,
          operation: null,
          error: null,
          checks: [],
          startedAt: receivedAt,
          terminal: "MOCK: no terminal command is executed",
          evidence: {
            resources: plan.resources.map((resource, index) => ({
              ...resource,
              metadata: {
                ...(resource.metadata as Record<string, unknown>),
                uid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              },
            })),
            events: [],
            receivedAt,
            status: [
              {
                kind: "Pod",
                state: "current",
                receivedAt,
                resourceVersion: "mock-7",
              },
            ],
            connection: {
              state: "current",
              lastObservation: receivedAt,
              reasons: [],
            },
          },
        },
        scheduledExecutions: [],
        resetPreview: null,
      },
    });
  });
  const previews: Record<string, unknown>[] = [];
  await page.route("**/api/tutor", (route) => {
    const input = route.request().postDataJSON();
    previews.push(input);
    return route.fulfill({
      json: {
        digest: "a".repeat(64),
        question: input.question,
        context: { evidence: [] },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(
    page.getByText("Local application", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: projectA.label, exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Ask about this lab", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Ask about this lab resource",
  );
  await page
    .getByRole("textbox", { name: "Question about Kubernetes evidence" })
    .fill("Explain this mocked local lab.");
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect.poll(() => previews.length).toBe(1);
  expect(previews[0]).toMatchObject({
    labId,
    labGeneration: 2,
    labRevision: 7,
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Secrets / Vault", exact: true })
    .click();
  await page.getByRole("button", { name: projectA.label, exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Ask about this project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Ask about this project",
  );
  await page
    .getByRole("textbox", { name: "Question about Kubernetes evidence" })
    .fill("Explain the imported source dependencies.");
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect.poll(() => previews.length).toBe(2);
  expect(previews[1]).toMatchObject({ projectRevision: revision });
  for (const field of ["labId", "labGeneration", "labRevision", "exerciseId"])
    expect(previews[1]).not.toHaveProperty(field);
  await page.screenshot({
    path: test.info().outputPath("mock-source-ask-after-lab.png"),
    fullPage: true,
  });
});

test("MOCK UI: saved source URL survives initial selected-project hydration", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  let release!: () => void;
  const hydration = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/project", async (route) => {
    requested = true;
    await hydration;
    await route.fulfill({
      json: { selected: { revision, project: projectA } },
    });
  });
  const query = new URLSearchParams({
    view: "Topology",
    environment: "source",
    tab: "YAML",
    selected: "core/Service/storefront/web",
    workspace: A + ":" + projectA.id,
  });
  await page.goto("/?" + query.toString());
  await expect.poll(() => requested).toBe(true);
  release();
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const params = new URL(location.href).searchParams;
        return {
          view: params.get("view"),
          tab: params.get("tab"),
          selected: params.get("selected"),
          workspace: params.get("workspace"),
        };
      }),
    )
    .toEqual({
      view: "Topology",
      tab: "YAML",
      selected: "core/Service/storefront/web",
      workspace: A + ":" + projectA.id,
    });
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  await expect(editor).toContainText("account-a-original-file");
  await expect(
    page.getByRole("tab", { name: "YAML", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("mock-restored-source-url.png"),
    fullPage: true,
  });
});

test("MOCK UI: saved Practice URL hydrates its project before matching the owned lab", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  await page.route("**/api/project", (route) =>
    route.fulfill({ json: { selected: { revision, project: projectA } } }),
  );
  const plan = deploymentPlan(projectA, "waypoint-lab-123456789abc");
  const labId = "00000000-0000-4000-8000-000000000099";
  await page.route("**/api/lab", (route) => {
    const receivedAt = new Date().toISOString();
    return route.fulfill({
      json: {
        plan: null,
        lab: {
          id: labId,
          generation: 2,
          revision: 7,
          phase: "ready",
          namespace: plan.namespace,
          plan,
          source: plan.source,
          incident: null,
          operation: null,
          error: null,
          checks: [],
          startedAt: receivedAt,
          terminal: "MOCK: no terminal command is executed",
          evidence: {
            resources: plan.resources.map((resource, index) => ({
              ...resource,
              metadata: {
                ...(resource.metadata as Record<string, unknown>),
                uid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              },
            })),
            events: [],
            receivedAt,
            status: [
              {
                kind: "Pod",
                state: "current",
                receivedAt,
                resourceVersion: "mock-7",
              },
            ],
            connection: {
              state: "current",
              lastObservation: receivedAt,
              reasons: [],
            },
          },
        },
        scheduledExecutions: [],
        resetPreview: null,
      },
    });
  });
  const query = new URLSearchParams({
    view: "Practice",
    environment: "lab",
    workspace: A + ":" + projectA.id,
    labSession: labId,
    labGeneration: "2",
    labTab: "overview",
  });
  await page.goto("/?" + query.toString());
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Local application", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open CLI project", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("A lab for a previous project is still running.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        view: new URL(location.href).searchParams.get("view"),
        environment: new URL(location.href).searchParams.get("environment"),
        labSession: new URL(location.href).searchParams.get("labSession"),
        labGeneration: new URL(location.href).searchParams.get("labGeneration"),
      })),
    )
    .toEqual({
      view: "Practice",
      environment: "lab",
      labSession: labId,
      labGeneration: "2",
    });
  await page.screenshot({
    path: test.info().outputPath("mock-restored-practice-url.png"),
    fullPage: true,
  });
});

test("MOCK UI: a held pre-import GET cannot replace the confirmed browser import", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  let releaseOld!: () => void, releaseLater!: () => void;
  const heldOld = new Promise<void>((resolve) => (releaseOld = resolve));
  const heldLater = new Promise<void>((resolve) => (releaseLater = resolve));
  let gets = 0,
    oldRequested = false,
    laterRequested = false;
  let selected = { revision, project: projectA };
  const writes: { kind: string; project: typeof projectA }[] = [];
  await page.route("**/api/project", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      selected = {
        revision: "00000000-0000-4000-8000-000000000022",
        project: body.project,
      };
      await route.fulfill({ json: { selected } });
      return;
    }
    gets++;
    if (gets === 2) {
      oldRequested = true;
      await heldOld;
      await route.fulfill({
        json: { selected: { revision, project: projectA } },
      });
    } else if (gets > 2) {
      laterRequested = true;
      await heldLater;
      await route.fulfill({ json: { selected } });
    } else await route.fulfill({ json: { selected } });
  });
  try {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: projectA.label, exact: true }),
    ).toBeVisible();
    await expect.poll(() => oldRequested).toBe(true);
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page
      .getByLabel("Paste manifests or snapshot JSON")
      .fill(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: self-import-canary\n  namespace: default\ndata:\n  publicSetting: hello\n",
      );
    await page
      .getByRole("button", { name: "Review pasted content", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm import", exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ kind: "select" });
    expect(writes[0].project.files[0].content).toContain("self-import-canary");
    await expect(
      page.getByRole("button", {
        name: "ConfigMap self-import-canary",
        exact: true,
      }),
    ).toBeVisible();
    releaseOld();
    // The next poll starts only after processing the old response. Block that
    // poll so a later good response cannot conceal an intermediate overwrite.
    await expect.poll(() => laterRequested).toBe(true);
    await expect(
      page.getByRole("button", {
        name: "ConfigMap self-import-canary",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: projectA.label, exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          new URL(location.href).searchParams.get("workspace"),
        ),
      )
      .toBe(A + ":" + selected.project.id);
    await page.screenshot({
      path: test.info().outputPath("mock-self-import-after-old-get.png"),
      fullPage: true,
    });
  } finally {
    releaseOld();
    releaseLater();
  }
});

test("MOCK UI: choosing a recent project persists canonical selection across reload", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  const projectB = importSnapshot(
    JSON.stringify({
      ...example,
      id: "mock-recent-project-b",
      label: "Recent project B",
      files: example.files.map((file) => ({
        ...file,
        content: file.content + "\n# recent-project-b-original-file\n",
      })),
    }),
  );
  await page.addInitScript(
    ({ key, projects }) => {
      if (!localStorage.getItem("audit-recent-project-initialized")) {
        localStorage.setItem(
          "waypoint:projects:v1:" + key,
          JSON.stringify(projects),
        );
        localStorage.setItem("audit-recent-project-initialized", "yes");
      }
    },
    { key: A, projects: [projectA, projectB] },
  );
  let selected = { revision, project: projectA };
  const writes: { kind: string; project: typeof projectA }[] = [];
  await page.route("**/api/project", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      selected = {
        revision: "00000000-0000-4000-8000-000000000033",
        project: body.project,
      };
    }
    return route.fulfill({ json: { selected } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: projectA.label, exact: true }).click();
  await page
    .getByRole("menuitem", { name: projectB.label, exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    kind: "select",
    project: { id: projectB.id },
  });
  await expect(
    page.getByRole("button", { name: projectB.label, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: projectB.label, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => new URL(location.href).searchParams.get("workspace")),
    )
    .toBe(A + ":" + projectB.id);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "YAML source editor" }),
  ).toContainText("recent-project-b-original-file");
  await page.screenshot({
    path: test.info().outputPath("mock-recent-project-after-reload.png"),
    fullPage: true,
  });
});

test("MOCK UI: endpoint metadata updates retain saved and unsaved analysis drafts", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  const otherContract = {
    namespace: "storefront",
    deployment: "gateway",
    container: "web",
    path: "/unrelated-existing-contract",
    port: 8080,
    responseBody: "unrelated-response-contract",
  };
  const metadataProject = importSnapshot(
    JSON.stringify({
      ...projectA,
      contracts: [...projectA.contracts, otherContract],
    }),
  );
  let selected = { revision, project: metadataProject };
  const writes: { kind: string; project: typeof projectA }[] = [];
  await page.route("**/api/project", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      selected = {
        revision: "00000000-0000-4000-8000-000000000044",
        project: body.project,
      };
    }
    return route.fulfill({ json: { selected } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => new URL(location.href).searchParams.get("workspace")),
    )
    .toBe(A + ":" + projectA.id);
  await page.getByRole("button", { name: "Service web", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  const original = await editor.innerText();
  await editor.fill(original + "\n# saved-analysis-draft-canary\n");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved draft", { exact: true })).toBeVisible();
  await editor.fill(
    original +
      "\n# saved-analysis-draft-canary\n# unsaved-analysis-draft-canary\n",
  );
  await expect(page.getByText("Unsaved draft", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Application settings", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Configure practice endpoint", exact: true })
    .click();
  await page
    .getByLabel("Known healthy HTTP path")
    .fill("/metadata-canary-health");
  await page
    .getByRole("button", { name: "Declare supported endpoint", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ kind: "select" });
  expect(
    writes[0].project.contracts.find(
      (contract) => contract.deployment === "web",
    ),
  ).toMatchObject({
    path: "/metadata-canary-health",
  });
  expect(writes[0].project.contracts).toContainEqual(otherContract);
  expect(writes[0].project.files).toEqual(projectA.files);
  await expect(editor).toContainText("saved-analysis-draft-canary");
  await expect(editor).toContainText("unsaved-analysis-draft-canary");
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("button", { name: projectA.label, exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("saved-analysis-draft-canary");
  await expect(editor).toContainText("unsaved-analysis-draft-canary");
  await expect(page.getByText("Unsaved draft", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(editor).toContainText("saved-analysis-draft-canary");
  await expect(editor).not.toContainText("unsaved-analysis-draft-canary");
  await page.screenshot({
    path: test.info().outputPath("mock-draft-after-endpoint-metadata.png"),
    fullPage: true,
  });
});

test("MOCK UI: a GET begun during a pending import cannot undo its successful POST", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  let releasePost!: () => void,
    releaseOld!: () => void,
    releaseLater!: () => void;
  const heldPost = new Promise<void>((resolve) => (releasePost = resolve));
  const heldOld = new Promise<void>((resolve) => (releaseOld = resolve));
  const heldLater = new Promise<void>((resolve) => (releaseLater = resolve));
  let postStarted = false,
    duringPostGetStarted = false,
    laterRequested = false;
  let selected = { revision, project: projectA };
  await page.route("**/api/project", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      postStarted = true;
      await heldPost;
      selected = {
        revision: "00000000-0000-4000-8000-000000000055",
        project: body.project,
      };
      await route.fulfill({ json: { selected } });
    } else if (postStarted && !duringPostGetStarted) {
      duringPostGetStarted = true;
      await heldOld;
      await route.fulfill({
        json: { selected: { revision, project: projectA } },
      });
    } else if (duringPostGetStarted) {
      laterRequested = true;
      await heldLater;
      await route.fulfill({ json: { selected } });
    } else await route.fulfill({ json: { selected } });
  });
  try {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: projectA.label, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page
      .getByLabel("Paste manifests or snapshot JSON")
      .fill(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: during-post-canary\n  namespace: default\ndata:\n  publicSetting: hello\n",
      );
    await page
      .getByRole("button", { name: "Review pasted content", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm import", exact: true })
      .click();
    await expect.poll(() => postStarted).toBe(true);
    await expect.poll(() => duringPostGetStarted).toBe(true);
    releasePost();
    await expect(
      page.getByRole("button", {
        name: "ConfigMap during-post-canary",
        exact: true,
      }),
    ).toBeVisible();
    releaseOld();
    await expect.poll(() => laterRequested).toBe(true);
    await expect(
      page.getByRole("button", {
        name: "ConfigMap during-post-canary",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: projectA.label, exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("mock-during-post-get-rejected.png"),
      fullPage: true,
    });
  } finally {
    releasePost();
    releaseOld();
    releaseLater();
  }
});

test("MOCK UI: overlapping recent-project selections do not start competing POSTs", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  const projects = ["B", "C"].map((letter) =>
    importSnapshot(
      JSON.stringify({
        ...example,
        id: "mock-overlap-project-" + letter,
        label: "Overlap project " + letter,
      }),
    ),
  );
  await page.addInitScript(
    ({ key, projects }) =>
      localStorage.setItem(
        "waypoint:projects:v1:" + key,
        JSON.stringify(projects),
      ),
    { key: A, projects: [projectA, ...projects] },
  );
  let releasePost!: () => void;
  const heldPost = new Promise<void>((resolve) => (releasePost = resolve));
  const writes: { kind: string; project: typeof projectA }[] = [];
  let selected = { revision, project: projectA };
  await page.route("**/api/project", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push(body);
      await heldPost;
      selected = {
        revision: "00000000-0000-4000-8000-000000000066",
        project: body.project,
      };
    }
    await route.fulfill({ json: { selected } });
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: projectA.label, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: projects[0].label, exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    await page
      .getByRole("button", { name: projectA.label, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: projects[1].label, exact: true })
      .click();
    await expect(
      page.getByText(
        "A project change is already saving. Please retry when it finishes.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].project.id).toBe(projects[0].id);
    releasePost();
    await expect(
      page.getByRole("button", { name: projects[0].label, exact: true }),
    ).toBeVisible();
    expect(writes).toHaveLength(1);
  } finally {
    releasePost();
  }
});

test("MOCK UI: failed live polling marks retained evidence stale and retry recovers", async ({
  page,
}) => {
  await mockCommon(page, () => A);
  await page.route("**/api/project", (route) =>
    route.fulfill({ json: { selected: { revision, project: projectA } } }),
  );
  const plan = deploymentPlan(projectA, "waypoint-lab-123456789abc");
  const labId = "00000000-0000-4000-8000-000000000099";
  const serviceIndex = plan.resources.findIndex(
    (resource) =>
      resource.kind === "Service" &&
      (resource.metadata as Record<string, unknown> | undefined)?.name ===
        "web",
  );
  expect(serviceIndex).toBeGreaterThanOrEqual(0);
  const uid = (index: number) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  let disconnected = false;
  const methods: string[] = [];
  await page.route("**/api/lab", (route) => {
    methods.push(route.request().method());
    if (disconnected)
      return route.fulfill({
        status: 503,
        json: { error: "MOCK runtime transport unavailable" },
      });
    const receivedAt = new Date().toISOString();
    return route.fulfill({
      json: {
        plan: null,
        lab: {
          id: labId,
          generation: 2,
          revision: 7,
          phase: "ready",
          namespace: plan.namespace,
          plan,
          source: plan.source,
          incident: null,
          operation: null,
          error: null,
          checks: [],
          startedAt: receivedAt,
          terminal: "MOCK: no terminal command is executed",
          evidence: {
            resources: plan.resources.map((resource, index) => ({
              ...resource,
              metadata: {
                ...(resource.metadata as Record<string, unknown>),
                uid: uid(index),
              },
            })),
            events: [],
            receivedAt,
            status: [
              {
                kind: "Service",
                state: "current",
                receivedAt,
                resourceVersion: "mock-7",
              },
            ],
            connection: {
              state: "current",
              lastObservation: receivedAt,
              reasons: [],
            },
          },
        },
        scheduledExecutions: [],
        resetPreview: null,
      },
    });
  });
  const query = new URLSearchParams({
    view: "Practice",
    environment: "lab",
    workspace: A + ":" + projectA.id,
    labSession: labId,
    labGeneration: "2",
    labResource: uid(serviceIndex),
    labProject: snapshotDigest(projectA),
    labTab: "overview",
  });
  await page.goto("/?" + query);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  disconnected = true;
  const failureNotice = page
    .getByRole("status")
    .filter({ hasText: "Runtime disconnected" });
  await expect(failureNotice).toContainText(
    "MOCK runtime transport unavailable",
  );
  await expect(failureNotice).toContainText("Last observation:");
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Stale / unknown", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Service / web", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Start readiness investigation",
      exact: true,
    }),
  ).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("mock-live-disconnected-stale.png"),
    fullPage: true,
  });
  disconnected = false;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(failureNotice).toHaveCount(0);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText("Stale / unknown", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Service / web", exact: true }),
  ).toBeVisible();
  expect(methods.every((method) => method === "GET")).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("mock-live-reconnected.png"),
    fullPage: true,
  });
});
