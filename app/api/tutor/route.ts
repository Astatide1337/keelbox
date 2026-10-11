import { join } from "node:path";
import { minikubeRuntime } from "@/lib/server/minikube-runtime";
import { liveTutorContext } from "@/lib/tutor/live-context";
import { z } from "zod";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { initializeAuth, inference } from "@/lib/server/oauth";
import { requirePrincipal, assertPrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import { tutorContext, safeText } from "@/lib/tutor/context";
import { learningContextSchema } from "@/lib/practice/live-learning";
const inputSchema = z
  .object({
    kind: z.enum(["preview", "ask"]),
    requestId: z.string().uuid(),
    model: z.string().max(200).optional(),
    question: z.string().min(1).max(2000),
    resourceId: z.string().max(500).optional(),
    relationshipId: z.string().max(500).optional(),
    projectRevision: z.string().uuid().optional(),
    labId: z.string().uuid().optional(),
    labGeneration: z.number().int().positive().optional(),
    labRevision: z.number().int().nonnegative().optional(),
    learning: learningContextSchema.optional(),
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
const livePreviews = new Map<
  string,
  {
    scope: string;
    expires: number;
    preview: ReturnType<typeof liveTutorContext>;
  }
>();
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  let pendingKey: string | undefined;
  try {
    await initializeAuth();
    const principal = requirePrincipal(request),
      stores = ownedStores(principal);
    const input = inputSchema.parse(await boundedJson(request, 10000));
    async function load() {
      if (input.labId) {
        const runtime = minikubeRuntime(join(stores.root, "runtime"));
        await runtime.load();
        const view = runtime.view();
        if (
          view.lab?.id !== input.labId ||
          view.lab.generation !== input.labGeneration ||
          view.lab.revision !== input.labRevision ||
          view.lab.operation
        )
          throw Error(
            "Lab changed or an operation is running. Refresh its evidence before asking.",
          );
        return liveTutorContext(view, input);
      }
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
    const currentEvidence = await load();
    assertPrincipal(principal);
    const previewKey =
      principal.profile.key + ":" + principal.epoch + ":" + input.requestId;
    const liveScope = JSON.stringify([
      input.labId,
      input.labGeneration,
      input.labRevision,
      input.resourceId,
      input.relationshipId,
      input.learning,
      input.question,
    ]);
    for (const [key, value] of livePreviews)
      if (value.expires < Date.now()) livePreviews.delete(key);
    if (input.kind === "preview") {
      if (input.labId) {
        if (livePreviews.size >= 30)
          livePreviews.delete(livePreviews.keys().next().value!);
        livePreviews.set(previewKey, {
          scope: liveScope,
          expires: Date.now() + 300000,
          preview: currentEvidence as ReturnType<typeof liveTutorContext>,
        });
      }
      return Response.json({ ...currentEvidence, question: safeText(input.question) });
    }
    const retained = input.labId ? livePreviews.get(previewKey) : undefined;
    if (input.labId && (!retained || retained.scope !== liveScope))
      throw Error("Review the current lab evidence before sending.");
    const preview = retained?.preview ?? currentEvidence;
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
      { ...preview.context, question: safeText(input.question) },
      request.signal,
    );
    assertPrincipal(principal);
    const latest = await load();
    if (!input.labId && latest.digest !== preview.digest)
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
    return Response.json({ error: safeText((e as Error).message) }, { status: 400 });
  } finally {
    if (pendingKey) state.pending.delete(pendingKey);
  }
}
