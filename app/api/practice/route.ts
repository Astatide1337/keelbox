import { authorized, boundedJson, denied, csrf } from "@/lib/server/security";
import { initializeAuth } from "@/lib/server/oauth";
import { requirePrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import { importSnapshot } from "@/lib/domain/snapshot";
import { z } from "zod";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  try {
    await initializeAuth();
    const stores = ownedStores(requirePrincipal(request)),
      exerciseStore = stores.exercises;
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const data =
      params.get("list") === "1"
        ? await exerciseStore.list(params.get("cursor") ?? undefined)
        : id
          ? await exerciseStore.load(id)
          : { csrf: csrf(), connected: true };
    stores.guard();
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    await initializeAuth();
    const stores = ownedStores(requirePrincipal(request)),
      exerciseStore = stores.exercises;
    const input = z
      .object({
        exercise: z.unknown(),
        expectedSavedRevision: z.number().int().min(0).nullable(),
        project: z.unknown().optional(),
      })
      .parse(await boundedJson(request, 8_000_000));
    return Response.json(
      await exerciseStore.save(
        input.exercise,
        input.expectedSavedRevision,
        input.project
          ? importSnapshot(JSON.stringify(input.project))
          : undefined,
        stores.guard,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
