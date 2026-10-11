import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { freemem, cpus, platform } from "node:os";
import { run } from "../lib/server/process";
import { minikubeBinary } from "../lib/server/minikube";
export async function doctor() {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  for (const [name, command, args] of [
    ["flock", "flock", ["--version"]],
    ["Node", process.execPath, ["--version"]],
    ["Docker", "docker", ["info", "--format", "{{.ServerVersion}}"]],
    ["Minikube", minikubeBinary(), ["version", "--short"]],
    ["kubectl", "kubectl", ["version", "--client=true", "-o", "json"]],
  ] as const) {
    try {
      const out = await run(command, [...args], { timeout: 15000 });
      results.push({
        name,
        ok: true,
        detail: name === "kubectl" ? "available" : out.trim(),
      });
    } catch (e) {
      results.push({ name, ok: false, detail: (e as Error).message });
    }
  }
  results.push(
    {
      name: "Platform",
      ok: platform() === "linux",
      detail: "Initial lab driver supports Linux + Docker.",
    },
    {
      name: "CPU / memory",
      ok: cpus().length >= 2 && freemem() >= 4 * 1024 ** 3,
      detail: `${cpus().length} CPUs; ${(freemem() / 1024 ** 3).toFixed(1)} GiB free; lab requests 2 CPUs / 4 GiB.`,
    },
  );
  try {
    const endpoint = (
      await run(
        "docker",
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { timeout: 10000 },
      )
    ).trim();
    const active = process.env.DOCKER_HOST ?? endpoint;
    results.push({
      name: "Docker endpoint",
      ok: active.startsWith("unix://"),
      detail: active.startsWith("unix://")
        ? "Local Unix socket"
        : "A local Unix-socket Docker endpoint is required; remote Docker is unsupported.",
    });
  } catch (e) {
    results.push({
      name: "Docker endpoint",
      ok: false,
      detail: (e as Error).message,
    });
  }
  try {
    const disk = await statfs(process.env.PLAYGROUND_STATE_DIR ?? tmpdir());
    const free = disk.bavail * disk.bsize;
    results.push({
      name: "Disk",
      ok: free >= 10 * 1024 ** 3,
      detail: `${(free / 1024 ** 3).toFixed(1)} GiB available; minimum 10 GiB.`,
    });
  } catch (e) {
    results.push({ name: "Disk", ok: false, detail: (e as Error).message });
  }
  return results;
}
