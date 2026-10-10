import { z } from "zod";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { initializeAuth, inference } from "@/lib/server/oauth";
import { requirePrincipal, assertPrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import { tutorContext } from "@/lib/tutor/context";
const inputSchema = z
  .object({
    kind: z.enum(["preview", "ask"]),
    requestId: z.string().uuid(),
    model: z.string().max(200).optional(),
    question: z.string().min(1).max(2000),
    resourceId: z.string().max(500).optional(),
    relationshipId: z.string().max(500).optional(),
    projectRevision: z.string().uuid().optional(),
    exerciseId: z.string().uuid().optional(),
    exerciseRevision: z.number().int().min(0).optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const shared = globalThis as typeof globalThis & {
  waypointTutor?: {
    pending: Set<string>;
    answers: Map<
      string,
      { fingerprint: string; text: string; expires: number }
    >;
  };
};
const state = (shared.waypointTutor ??= {
  pending: new Set(),
  answers: new Map(),
});
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  let pendingKey: string | undefined;
  try {
    await initializeAuth();
    const principal = requirePrincipal(request),
      stores = ownedStores(principal);
    const input = inputSchema.parse(await boundedJson(request, 5000));
    async function load() {
      if (input.exerciseId) {
        const saved = await stores.exercises.load(input.exerciseId);
        if (
          saved.exercise.revision !== input.exerciseRevision ||
          saved.savedRevision !== input.exerciseRevision
        )
          throw Error(
            "Practice evidence changed or checkpoint is still saving. Try again after it is saved.",
          );
        return tutorContext(saved.exercise.source, input, saved.exercise);
      }
      const saved = await stores.project.load();
      if (!saved || saved.revision !== input.projectRevision)
        throw Error(
          "Save/select this project before asking. The selected project revision changed.",
        );
      return tutorContext(saved.project, input);
    }
    const preview = await load();
    assertPrincipal(principal);
    if (input.kind === "preview")
      return Response.json({ ...preview, question: input.question });
    if (!input.model || input.digest !== preview.digest)
      throw Error("Review the current outgoing evidence before sending.");
    const key = principal.profile.key + ":" + input.requestId,
      fingerprint = JSON.stringify([
        principal.epoch,
        input.model,
        input.question,
        preview.digest,
      ]);
    for (const [k, a] of state.answers)
      if (a.expires < Date.now()) state.answers.delete(k);
    const cached = state.answers.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw Error("Request ID was already used with different evidence.");
      return Response.json({
        text: cached.text,
        context: preview.context,
        digest: preview.digest,
      });
    }
    if (state.pending.has(principal.profile.key))
      return Response.json(
        { error: "A question is already running for this account." },
        { status: 409 },
      );
    pendingKey = principal.profile.key;
    state.pending.add(pendingKey);
    const answer = await inference(
      principal,
      input.model,
      { ...preview.context, question: input.question },
      request.signal,
    );
    assertPrincipal(principal);
    if ((await load()).digest !== preview.digest)
      throw Error(
        "Evidence changed during inference. The late answer was discarded; your question is retained.",
      );
    if (state.answers.size >= 50)
      state.answers.delete(state.answers.keys().next().value!);
    state.answers.set(key, {
      fingerprint,
      text: answer,
      expires: Date.now() + 300000,
    });
    return Response.json({
      text: answer,
      context: preview.context,
      digest: preview.digest,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  } finally {
    if (pendingKey) state.pending.delete(pendingKey);
  }
}
