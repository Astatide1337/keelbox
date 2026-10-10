import { authorized, denied, boundedJson } from "@/lib/server/security";
import { initializeAuth } from "@/lib/server/oauth";
import { requirePrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import { projectStore } from "@/lib/server/project-store";
import { importSnapshot } from "@/lib/domain/snapshot";
import { z } from "zod";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  try {
    await initializeAuth();
    const stores = ownedStores(requirePrincipal(request));
    const selected = await stores.project.load();
    stores.guard();
    return Response.json(
      { selected },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    await initializeAuth();
    const stores = ownedStores(requirePrincipal(request));
    const input = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("select"), project: z.unknown() }).strict(),
        z.object({ kind: z.literal("copy-development") }).strict(),
      ])
      .parse(await boundedJson(request, 2100000));
    const project =
      input.kind === "select"
        ? importSnapshot(JSON.stringify(input.project))
        : (await projectStore.load())?.project;
    if (!project) throw Error("No development project is available to copy.");
    return Response.json({
      selected: await stores.project.select(project, stores.guard),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
