import { z } from "zod";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { runtime, safeError } from "@/lib/server/runtime";
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    const input = z
      .object({
        kind: z.enum(["inspect", "events", "logs"]),
        name: z
          .string()
          .max(253)
          .regex(/^[a-zA-Z0-9.-]*$/),
      })
      .parse(await boundedJson(request, 1024));
    return Response.json({
      data: await runtime.inspect(input.kind, input.name),
      capturedAt: new Date().toISOString(),
    });
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 400 });
  }
}
