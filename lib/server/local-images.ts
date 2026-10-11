import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { run } from "./process";

type Runner = typeof run;

// Only operator configuration can authorize a build. Manifest annotations and
// generated scenarios cannot supply a host path or Docker command.
export function dockerBuildContexts(
  value = process.env.WAYPOINT_DOCKER_BUILD_CONTEXTS,
) {
  if (!value) return {} as Record<string, string>;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error(
      "WAYPOINT_DOCKER_BUILD_CONTEXTS must map image references to absolute build directories.",
    );
  for (const [image, context] of Object.entries(parsed)) {
    if (
      !image ||
      image.startsWith("-") ||
      /\s/.test(image) ||
      typeof context !== "string" ||
      !isAbsolute(context)
    )
      throw Error(
        "Docker build mappings require an image reference and an absolute directory.",
      );
  }
  return parsed as Record<string, string>;
}

export async function resolveLocalImage(
  reference: string,
  contexts: Record<string, string>,
  command: Runner = run,
): Promise<{ imageId: string | null; buildError?: string }> {
  const inspect = async () => {
    try {
      const id = (
        await command("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          reference,
        ])
      ).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id))
        throw Error("Docker returned an invalid image identity.");
      return id;
    } catch (error) {
      if (/No such (?:image|object)/i.test(String(error))) return null;
      throw error;
    }
  };
  const cached = await inspect();
  if (cached) return { imageId: cached };
  if (!contexts[reference]) return { imageId: null };
  try {
    const context = await realpath(contexts[reference]);
    if (!(await stat(join(context, "Dockerfile"))).isFile())
      throw Error(
        "Configured Docker build directory must contain a Dockerfile.",
      );
    await command(
      "docker",
      [
        "build",
        "--tag",
        reference,
        "--file",
        join(context, "Dockerfile"),
        context,
      ],
      { timeout: 600000 },
    );
  } catch (error) {
    return {
      imageId: null,
      buildError: error instanceof Error ? error.message : String(error),
    };
  }
  const built = await inspect();
  if (!built)
    throw Error("Docker build completed without the requested image.");
  return { imageId: built };
}
