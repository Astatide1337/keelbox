import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import example from "../../examples/storefront/snapshot.json";
import { analyze } from "../../lib/domain/analyzer";
import { deploymentPlan } from "../../lib/domain/deployment-plan";
import { parseSources } from "../../lib/domain/importer";
import {
  importSnapshot,
  manifestProject,
  projectResources,
} from "../../lib/domain/snapshot";
import { graphProjection } from "../../lib/domain/presentation";
import { at, text, type Relationship } from "../../lib/domain/types";

// Controlled graph interaction only. Every auth/project/lab API is mocked;
// no credentials, inference, live cluster, or mutation operation is used.
const account = "a".repeat(64);
const revision = "00000000-0000-4000-8000-000000000011";
const project = importSnapshot(
  JSON.stringify({
    ...example,
    id: "mock-exact-edge-project",
    label: "Exact edge fixture",
  }),
);
const plan = deploymentPlan(project, "waypoint-lab-123456789abc");
const liveResources = [
  ...plan.resources,
  ...example.resources.filter((r) =>
    ["Pod", "ReplicaSet", "EndpointSlice"].includes(r.kind),
  ),
].map((r, index) => ({
  ...r,
  metadata: {
    ...(r.metadata as Record<string, unknown>),
    namespace: plan.namespace,
    uid:
      text(at(r, "metadata", "uid")) ||
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  },
}));
const liveParsed = parseSources([
  {
    id: "live",
    name: "Live Kubernetes response",
    content: liveResources.map((r) => stringify(r)).join("---\n"),
  },
]);
const live = liveParsed.resources.map((r) => ({
  ...r,
  id: text(at(r.raw, "metadata", "uid")),
}));
const sourceEdge = analyze(
  projectResources(project),
  project.resources,
).relationships.find((r) => r.title === "EndpointSlice association")!;
const liveEdge = analyze(live).relationships.find(
  (r) => r.title === "EndpointSlice association",
)!;
const sourceRelations = graphProjection(
  projectResources(project),
  analyze(projectResources(project), project.resources).relationships,
  project,
);
const ownerEdge = sourceRelations.find(
  (edge) =>
    edge.kind === "owns" &&
    edge.from.includes("/ReplicaSet/") &&
    edge.to?.includes("/Pod/"),
)!;

function labResponse(enabled: boolean, labRevision = 7, source = plan.source) {
  const receivedAt = new Date().toISOString();
  return {
    plan: null,
    lab: enabled
      ? {
          id: "00000000-0000-4000-8000-000000000099",
          generation: 2,
          revision: labRevision,
          phase: "ready",
          namespace: plan.namespace,
          plan,
          source,
          incident: null,
          operation: null,
          error: null,
          checks: [],
          startedAt: receivedAt,
          terminal: "MOCK: no terminal command is executed",
          evidence: {
            resources: liveResources,
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
        }
      : null,
    scheduledExecutions: [],
    resetPreview: null,
  };
}

async function mocks(page: Page, lab: boolean) {
  await page.route("**/api/auth", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        profile: { kind: "chatgpt", key: account, label: "Mock edge account" },
        epoch: "mock-edge-epoch",
        csrf: "mock-csrf",
        accounts: [],
        issues: [],
        planEnabled: true,
        needsWelcome: false,
      },
    }),
  );
  await page.route("**/api/auth?models=1", (route) =>
    route.fulfill({
      json: { models: [{ id: "mock-model", name: "Mock model" }] },
    }),
  );
  await page.route("**/api/configuration", (route) =>
    route.fulfill({ json: { secrets: [], vault: { entries: [] } } }),
  );
  let selected = { revision, project };
  await page.route("**/api/project", (route) => {
    if (route.request().method() === "POST")
      selected = { revision, project: route.request().postDataJSON().project };
    return route.fulfill({ json: { selected } });
  });
  await page.route("**/api/lab", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: labResponse(lab) });
  });
}

async function clickEdge(page: Page, relationship: Relationship) {
  const path = page.locator(
    `.react-flow__edge[data-id=${JSON.stringify(relationship.id)}] .react-flow__edge-interaction`,
  );
  await expect(path).toHaveCount(1);
  await path.scrollIntoViewIfNeeded();
  const point = await path.evaluate((node) => {
    const path = node as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() * 0.8);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
}

test("MOCK edges: source click reveals only the exact relationship after another resource was selected", async ({
  page,
}) => {
  const next = manifestProject([
    {
      id: "next-source",
      name: "Next edge project",
      content:
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: next-source\ndata:\n  publicSetting: hello\n",
    },
  ]);
  await page.addInitScript(
    ({ account, next }) =>
      localStorage.setItem(
        "waypoint:projects:v1:" + account,
        JSON.stringify([next]),
      ),
    { account, next },
  );
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
  await mocks(page, false);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: project.label, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Deployment gateway", exact: true })
    .click();
  await clickEdge(page, sourceEdge);
  await expect(
    page.getByRole("tab", { name: "Relationships", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(
    page
      .locator(".relationship-evidence")
      .filter({ hasText: sourceEdge.title }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("mock-source-exact-edge.png"),
    fullPage: true,
  });
  await expect(page.locator(".relationship-evidence")).toHaveCount(1);

  // Citation navigation must clear the focused edge before showing the newly
  // selected EndpointSlice's complete relationship set.
  await page
    .locator(".relationship-evidence")
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByRole("tab", { name: "YAML", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await page.getByRole("tab", { name: "Relationships", exact: true }).click();
  await page.getByRole("button", { name: /^Relationship evidence \(/ }).click();
  await expect(page.locator(".relationship-evidence")).toHaveCount(
    sourceRelations.filter(
      (edge) => edge.from === sourceEdge.to || edge.to === sourceEdge.to,
    ).length,
  );

  // Owner navigation starts from a focused ReplicaSet→Pod edge, then opens
  // the Deployment, which is not an endpoint of that previously selected edge.
  await clickEdge(page, ownerEdge);
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect owner", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => new URL(location.href).searchParams.get("selected")),
    )
    .toBe("apps/Deployment/storefront/web");
  await page
    .getByRole("button", { name: "Ask about this resource", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Question about Kubernetes evidence" })
    .fill("Explain the selected owner.");
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect.poll(() => previews.length).toBe(1);
  expect(previews[0]).toMatchObject({
    resourceId: "apps/Deployment/storefront/web",
  });
  expect(previews[0]).not.toHaveProperty("relationshipId");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await clickEdge(page, sourceEdge);
  await expect(page.locator(".relationship-evidence")).toHaveCount(1);
  await expect(page.locator(".relationship-evidence")).toContainText(
    sourceEdge.title,
  );

  // Adopt a different source while an exact edge is focused, and confirm it cannot leak
  // into the project-level Ask preview.
  await page.getByRole("button", { name: project.label, exact: true }).click();
  await page.getByRole("menuitem", { name: next.label, exact: true }).click();
  await expect(
    page.getByRole("button", { name: next.label, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".relationship-evidence")).toHaveCount(0);
  await page.getByRole("button", { name: next.label, exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Ask about this project", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Question about Kubernetes evidence" })
    .fill("Explain the newly adopted source.");
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect.poll(() => previews.length).toBe(2);
  expect(previews[1]).not.toHaveProperty("resourceId");
  expect(previews[1]).not.toHaveProperty("relationshipId");
});

test("MOCK edges: live click pairs the exact relationship with its source resource", async ({
  page,
}) => {
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
  await mocks(page, true);
  await page.goto(
    "/?" +
      new URLSearchParams({
        view: "Topology",
        environment: "lab",
        workspace: account + ":" + project.id,
      }),
  );
  await expect(
    page.getByRole("button", { name: "Deployment gateway", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Deployment gateway", exact: true })
    .click();
  await clickEdge(page, liveEdge);
  const panel = page.getByRole("tabpanel", {
    name: "Relationships",
    exact: true,
  });
  await expect(panel.locator("article")).toHaveCount(1);
  await expect(panel).toContainText(liveEdge.title);
  await page.screenshot({
    path: test.info().outputPath("mock-live-exact-edge.png"),
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        new URL(location.href).searchParams.get("labResource"),
      ),
    )
    .toBe(liveEdge.from);
  await page.getByRole("button", { name: "Ask ChatGPT", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Question about Kubernetes evidence" })
    .fill("Explain the selected relationship.");
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click();
  await expect.poll(() => previews.length).toBe(1);
  expect(previews[0]).toMatchObject({
    resourceId: liveEdge.from,
    relationshipId: liveEdge.id,
    labGeneration: 2,
    labRevision: 7,
  });
});

test("MOCK edges: mobile live click opens the exact relationship inspector", async ({
  page,
}) => {
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 390, height: 844 });
  let receipt = 0;
  async function fullPane(selector: string) {
    await expect
      .poll(async () => {
        const box = await page.locator(selector).boundingBox();
        const group = await page.locator(".lab-panels").boundingBox();
        return !!box && !!group && box.x < 48 && box.width >= group.width - 2;
      })
      .toBe(true);
    const receiptPath = test
      .info()
      .outputPath(
        `mobile-layout-${++receipt}-${selector.replace(/\W/g, "")}.json`,
      );
    await writeFile(
      receiptPath,
      JSON.stringify(
        await page.locator(".lab-panels").evaluate((group) => ({
          group: {
            style: group.getAttribute("style"),
            display: getComputedStyle(group).display,
            columns: getComputedStyle(group).gridTemplateColumns,
            width: group.getBoundingClientRect().width,
            pane: group.getAttribute("data-mobile-pane"),
          },
          children: Array.from(group.children).map((child) => ({
            slot: child.getAttribute("data-slot"),
            panel: child.getAttribute("data-panel"),
            pane: child.getAttribute("data-pane"),
            class: child.getAttribute("class"),
            style: child.getAttribute("style"),
            display: getComputedStyle(child).display,
            width: child.getBoundingClientRect().width,
            x: child.getBoundingClientRect().x,
            inner: Array.from(child.children).map((node) => ({
              slot: node.getAttribute("data-slot"),
              class: node.getAttribute("class"),
              style: node.getAttribute("style"),
              display: getComputedStyle(node).display,
              width: node.getBoundingClientRect().width,
            })),
          })),
        })),
        null,
        2,
      ),
    );
    await test.info().attach(`mobile-layout-${receipt}`, {
      path: receiptPath,
      contentType: "application/json",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(391);
    if (selector === ".graph-canvas") {
      await expect
        .poll(
          async () =>
            (await page.locator(".graph-canvas .react-flow").boundingBox())
              ?.height ?? 0,
        )
        .toBeGreaterThan(400);
    }
  }
  await mocks(page, true);
  await page.goto(
    "/?" +
      new URLSearchParams({
        view: "Topology",
        environment: "lab",
        workspace: account + ":" + project.id,
      }),
  );
  await expect(
    page.getByRole("button", { name: "Deployment gateway", exact: true }),
  ).toBeVisible();
  const initialGeometry = await page
    .locator(".lab-panels")
    .evaluate((group) => ({
      viewport: { width: innerWidth, height: innerHeight },
      elements: [
        group,
        ...group.querySelectorAll(
          '[data-slot="resizable-panel"], .graph-canvas, .react-flow, .react-flow__controls, .react-flow__controls-fitview',
        ),
      ].map((element) => ({
        tag: element.tagName,
        slot: element.getAttribute("data-slot"),
        pane: element.getAttribute("data-pane"),
        class: element.getAttribute("class"),
        style: element.getAttribute("style"),
        display: getComputedStyle(element).display,
        height: getComputedStyle(element).height,
        minHeight: getComputedStyle(element).minHeight,
        flex: getComputedStyle(element).flex,
        rect: element.getBoundingClientRect().toJSON(),
      })),
    }));
  await writeFile(
    test.info().outputPath("mobile-initial-geometry.json"),
    JSON.stringify(initialGeometry, null, 2),
  );
  await page
    .getByRole("button", { name: "Deployment gateway", exact: true })
    .click();
  await fullPane(".live-inspector");
  const panes = page.locator('[aria-label="Workspace pane"]');
  await panes.getByRole("button", { name: "Resources", exact: true }).click();
  await fullPane(".resource-tree");
  await page
    .locator('[aria-label="Workspace pane"]')
    .getByRole("button", { name: "Topology", exact: true })
    .click();
  await fullPane(".graph-canvas");
  await clickEdge(page, liveEdge);
  const panel = page.getByRole("tabpanel", {
    name: "Relationships",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(panel.locator("article")).toHaveCount(1);
  await expect(panel).toContainText(liveEdge.title);
  await fullPane(".live-inspector");
  await panes.getByRole("button", { name: "Topology", exact: true }).click();
  await fullPane(".graph-canvas");
  await panes.getByRole("button", { name: "Inspector", exact: true }).click();
  await fullPane(".live-inspector");
  await expect(panel).toContainText(liveEdge.title);
  await page.screenshot({
    path: test.info().outputPath("mock-mobile-live-edge.png"),
    fullPage: true,
  });
});

test("MOCK editor: Manifest files applies validated repair with session scope and blocks stale transport", async ({
  page,
}) => {
  page.setDefaultTimeout(15000);
  await mocks(page, true);
  let disconnected = false;
  let labRevision = 7;
  let source = plan.source;
  const writes: Record<string, unknown>[] = [];
  let releaseApply!: () => void;
  const heldApply = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  await page.route("**/api/lab", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      writes.push(input);
      expect(input.kind).toBe("apply");
      await heldApply;
      source = input.source;
      labRevision++;
      return route.fulfill({ json: labResponse(true, labRevision, source) });
    }
    if (disconnected)
      return route.fulfill({
        status: 503,
        json: { error: "MOCK repair transport unavailable" },
      });
    return route.fulfill({ json: labResponse(true, labRevision, source) });
  });
  await page.goto(
    "/?" +
      new URLSearchParams({
        view: "Topology",
        environment: "lab",
        workspace: account + ":" + project.id,
      }),
  );
  await expect(
    page.getByRole("button", { name: "Deployment gateway", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manifest files", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "YAML source editor" });
  const apply = page.getByRole("button", { name: "Apply repair", exact: true });
  await expect(editor).toHaveCount(1);
  await expect(apply).toHaveCount(1);
  await expect(apply).toBeDisabled();
  const malformed = "apiVersion: [\n# retained-invalid-lab-draft";
  await editor.fill(malformed);
  await expect(editor).toContainText("retained-invalid-lab-draft");
  await expect(
    page.getByRole("alert").filter({ hasText: "Line" }),
  ).toContainText("Draft retained");
  await expect(apply).toBeDisabled();
  expect(writes).toHaveLength(0);
  const repaired = plan.source.replace("path: /healthz", "path: /mock-ready");
  expect(repaired).not.toBe(plan.source);
  await editor.fill(repaired);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    kind: "apply",
    sessionId: "00000000-0000-4000-8000-000000000099",
    generation: 2,
    revision: 7,
    source: repaired,
  });
  expect(writes[0].operationId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(apply).toBeDisabled();
  const newerDraft = repaired + "\n# pending-repair-after-apply\n";
  await editor.fill(newerDraft);
  await expect(editor).toContainText("pending-repair-after-apply");
  const acknowledgment = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/lab") &&
      response.request().method() === "POST",
  );
  releaseApply();
  await acknowledgment;
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/lab") &&
      response.request().method() === "GET",
  );
  await expect(editor).toContainText("pending-repair-after-apply");
  await expect(apply).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath("mock-manifest-repair-applied.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(editor).toHaveCount(1);
  await editor.press("Control+End");
  await expect(editor).toContainText("pending-repair-after-apply");
  await expect(apply).toBeEnabled();
  disconnected = true;
  const notice = page
    .getByRole("status")
    .filter({ hasText: "Runtime disconnected" });
  await expect(notice).toContainText("MOCK repair transport unavailable");
  await expect(apply).toBeDisabled();
  await expect(editor).toContainText("pending-repair-after-apply");
  expect(writes).toHaveLength(1);
  await page.screenshot({
    path: test.info().outputPath("mock-manifest-repair-stale.png"),
    fullPage: true,
  });
  disconnected = false;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(notice).toHaveCount(0);
  await expect(apply).toBeEnabled();
  await expect(editor).toContainText("pending-repair-after-apply");
  expect(writes).toHaveLength(1);
});
