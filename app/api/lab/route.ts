import { initializeAuth } from "@/lib/server/oauth";
import { z } from "zod";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { requirePrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import { minikubeRuntime, LabConflict } from "@/lib/server/minikube-runtime";
import { OperationLockBusy } from "@/lib/server/operation-lock";
import { importSnapshot } from "@/lib/domain/snapshot";
import { join } from "node:path";
import { LIVE_INCIDENT_IDS } from "@/lib/domain/live-incidents";
const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), project: z.unknown() }),
  z.object({
    kind: z.literal("create"),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    kind: z.enum([
      "incident",
      "repair",
      "apply",
      "check",
      "reset",
      "recover",
      "cleanup",
      "run-cronjob",
    ]),
    operationId: z.string().uuid(),
    sessionId: z.string().uuid(),
    generation: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    source: z
      .string()
      .max(2_000_000)
      .refine(
        (value) => new TextEncoder().encode(value).length <= 2_000_000,
        "Repair source exceeds 2 MB.",
      )
      .optional(),
    incident: z.enum(LIVE_INCIDENT_IDS).optional(),
    target: z.string().max(800).optional(),
    proposalId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.enum(["logs", "closeLogs"]),
    sessionId: z.string().uuid(),
    generation: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    uid: z.string().uuid(),
    container: z
      .string()
      .max(253)
      .regex(/^[a-z0-9-]+$/),
  }),
]);
function service(request: Request) {
  const p = requirePrincipal(request),
    stores = ownedStores(p);
  return {
    runtime: minikubeRuntime(join(stores.root, "runtime")),
    guard: stores.guard,
  };
}
export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  try {
    await initializeAuth();
    const { runtime, guard } = service(request);
    await runtime.load();
    try {
      guard();
    } catch (e) {
      runtime.close();
      throw e;
    }
    return Response.json(runtime.view(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    await initializeAuth();
    const op = operation.parse(await boundedJson(request, 4_100_000)),
      { runtime, guard } = service(request);
    let data;
    if (op.kind === "plan")
      data = await runtime.plan(importSnapshot(JSON.stringify(op.project)));
    else if (op.kind === "create")
      data = await runtime.create(op.planHash, guard);
    else if (op.kind === "logs" || op.kind === "closeLogs")
      data = {
        logs: await runtime.logs(
          op.uid,
          op.container,
          op.kind === "closeLogs",
          op,
        ),
      };
    else data = await runtime.operate(op, guard);
    try {
      guard();
    } catch (e) {
      runtime.close();
      throw e;
    }
    return Response.json(data, { status: 202 });
  } catch (e) {
    return Response.json(
      { error: (e as Error).message },
      {
        status:
          e instanceof LabConflict || e instanceof OperationLockBusy
            ? 409
            : 400,
      },
    );
  }
}
