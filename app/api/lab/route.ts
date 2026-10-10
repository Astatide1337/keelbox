import { z } from "zod";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { Conflict, runtime, safeError } from "@/lib/server/runtime";
const scenarios = z.enum([
  "service-selector",
  "configmap-key",
  "readiness-path",
]);
const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), scenario: scenarios }),
  z.object({
    kind: z.enum(["apply", "verify", "reset", "stop"]),
    operationId: z.string().uuid(),
    sessionId: z.string().uuid(),
    generation: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    source: z.string().max(200000).optional(),
  }),
]);
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    const op = operation.parse(await boundedJson(request, 220000));
    const lab =
      op.kind === "start"
        ? await runtime.start(op.scenario)
        : await runtime.operate(op);
    return Response.json({ lab }, { status: 202 });
  } catch (e) {
    return Response.json(
      { error: safeError(e) },
      { status: e instanceof Conflict ? 409 : 400 },
    );
  }
}
