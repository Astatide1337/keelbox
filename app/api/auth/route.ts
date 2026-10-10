import { z } from "zod";
import {
  authStatus,
  initializeAuth,
  beginSignIn,
  loginOwner,
  attemptStatus,
  cancelSignIn,
  models,
  signOut,
  acknowledgeWelcome,
  inference,
} from "@/lib/server/oauth";
import { requirePrincipal } from "@/lib/server/auth/session";
import { authorized, boundedJson, denied, csrf } from "@/lib/server/security";
import { safeError } from "@/lib/server/runtime";
export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  try {
    await initializeAuth();
    const url = new URL(request.url);
    const attempt = url.searchParams.get("attempt");
    if (attempt)
      return Response.json(attemptStatus(attempt, loginOwner(request)), {
        headers: { "Cache-Control": "no-store" },
      });
    if (url.searchParams.has("models"))
      return Response.json({ models: await models(requirePrincipal(request)) });
    return Response.json(
      { ...(await authStatus()), csrf: csrf() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 400 });
  }
}
const operation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("login"),
      account: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("cancel"), attemptId: z.string().uuid() })
    .strict(),
  z.object({ kind: z.literal("welcome") }).strict(),
  z.object({ kind: z.literal("signout") }).strict(),
  z
    .object({
      kind: z.literal("test-inference"),
      model: z.string().min(1).max(200),
    })
    .strict(),
]);
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    await initializeAuth();
    const body = operation.parse(await boundedJson(request, 2000));
    if (body.kind === "login")
      return Response.json(
        await beginSignIn(loginOwner(request), body.account),
      );
    if (body.kind === "cancel") {
      cancelSignIn(body.attemptId, loginOwner(request));
      return Response.json({ ok: true });
    }
    const principal = requirePrincipal(request);
    if (body.kind === "signout") return Response.json(await signOut(principal));
    if (body.kind === "welcome") {
      await acknowledgeWelcome(principal);
      return Response.json({ ok: true });
    }
    return Response.json({
      text: await inference(
        principal,
        body.model,
        {
          purpose: "Connection test only. No cluster data is included.",
          question:
            "Reply with a short sentence confirming this inference request worked.",
        },
        request.signal,
      ),
    });
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 400 });
  }
}
