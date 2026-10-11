import { run } from "@/lib/server/process";
import { parseSources } from "@/lib/domain/importer";
import { at, list } from "@/lib/domain/types";
import { z } from "zod";
import { authorized, boundedJson, denied } from "@/lib/server/security";
import { initializeAuth } from "@/lib/server/oauth";
import { requirePrincipal } from "@/lib/server/auth/session";
import { ownedStores } from "@/lib/server/auth/stores";
import {
  LocalConfiguration,
  secretInput,
  vaultInput,
} from "@/lib/server/local-configuration";
import { digest } from "@/lib/domain/deployment-plan";
import { join } from "node:path";
async function context(request: Request) {
  await initializeAuth();
  const stores = ownedStores(requirePrincipal(request));
  const saved = await stores.project.load();
  if (!saved) throw Error("Import an application first.");
  return {
    stores,
    saved,
    key: digest(saved.project.files),
    configuration: new LocalConfiguration(join(stores.root, "configuration")),
  };
}
export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  try {
    const { configuration, key, stores } = await context(request);
    const result = configuration.public(await configuration.load(key));
    stores.guard();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    const input = z
      .union([
        z
          .object({ projectRevision: z.string().uuid(), secret: secretInput })
          .strict(),
        z
          .object({
            projectRevision: z.string().uuid(),
            image: z
              .object({
                original: z
                  .string()
                  .min(1)
                  .max(500)
                  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/),
                reference: z
                  .string()
                  .min(1)
                  .max(500)
                  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/),
              })
              .strict(),
          })
          .strict(),
        z
          .object({ projectRevision: z.string().uuid(), vault: vaultInput })
          .strict(),
      ])
      .parse(await boundedJson(request, 200000));
    const { configuration, key, stores, saved } = await context(request);
    if (saved.revision !== input.projectRevision)
      throw Error(
        "Selected project changed. Refresh before saving configuration.",
      );
    if ("image" in input) {
      const authored = parseSources(saved.project.files).resources.some((r) => {
        const spec =
          r.kind === "Pod"
            ? r.raw.spec
            : r.kind === "CronJob"
              ? at(r.raw, "spec", "jobTemplate", "spec", "template", "spec")
              : at(r.raw, "spec", "template", "spec");
        return [
          ...list(at(spec, "containers")),
          ...list(at(spec, "initContainers")),
        ].some((c) => c.image === input.image.original);
      });
      if (!authored)
        throw Error("Image is not referenced by the selected application.");
      let imageId: string;
      try {
        imageId = (
          await run("docker", [
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            input.image.reference,
          ])
        ).trim();
      } catch {
        throw Error(
          "Image is not available in local Docker. Pull it with Docker first, then select its tag here. Waypoint does not read registry credentials.",
        );
      }
      return Response.json(
        await configuration.saveImage(
          key,
          { ...input.image, imageId },
          stores.guard,
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      await ("secret" in input
        ? configuration.save(key, input.secret, stores.guard)
        : configuration.saveVault(key, input.vault, stores.guard)),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
