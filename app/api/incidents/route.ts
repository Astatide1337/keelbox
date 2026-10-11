import { z } from "zod";
import { join } from "node:path";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { initializeAuth, inference } from "@/lib/server/oauth";
import { requirePrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import { minikubeRuntime } from "@/lib/server/minikube-runtime";
import {
  recipeSchema,
  recipeEvidence,
  validateRecipe,
} from "@/lib/domain/generated-incident";
const input = z
  .object({
    kind: z.enum(["preview", "generate"]),
    sessionId: z.string().uuid(),
    generation: z.number().int(),
    revision: z.number().int(),
    model: z.string().max(200).optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    await initializeAuth();
    const principal = requirePrincipal(request),
      stores = ownedStores(principal),
      runtime = minikubeRuntime(join(stores.root, "runtime"));
    await runtime.load();
    const body = input.parse(await boundedJson(request, 4000));
    const lab = runtime.view().lab;
    if (
      !lab ||
      lab.id !== body.sessionId ||
      lab.generation !== body.generation ||
      lab.revision !== body.revision ||
      lab.phase !== "ready" ||
      lab.operation
    )
      throw Error(
        "A current healthy baseline is required before generating an incident.",
      );
    const preview = recipeEvidence(lab.plan);
    if (!preview.context.targets.length)
      throw Error(
        "No compatible probe-based incident targets exist in this application.",
      );
    if (body.kind === "preview")
      return Response.json(preview, {
        headers: { "Cache-Control": "no-store" },
      });
    if (!body.model || body.digest !== preview.digest)
      throw Error("Review the outgoing summary before generating an incident.");
    const answer = await inference(
      principal,
      body.model,
      { ...preview.context, question: preview.context.constraints.output },
      request.signal,
      (() => {
        const schema = z.toJSONSchema(recipeSchema);
        delete schema.$schema;
        return schema;
      })(),
    );
    stores.guard();
    const current = runtime.view().lab;
    if (
      !current ||
      current.id !== lab.id ||
      current.generation !== lab.generation ||
      current.revision !== lab.revision ||
      current.phase !== "ready" ||
      current.operation
    )
      throw Error("Lab changed during generation. The proposal was discarded.");
    const json = answer
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const recipe = validateRecipe(JSON.parse(json), lab.plan);
    const proposal = runtime.propose(recipe, body);
    return Response.json(
      { proposal },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
