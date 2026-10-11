import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createHash } from "node:crypto";
import { run } from "./process";
import { at, list, object, text } from "../domain/types";
export type OwnedTarget = {
  profile: string;
  home: string;
  kubeconfig: string;
  namespace: string;
  containerId?: string;
  fingerprint?: string;
  clusterUid?: string;
  namespaceUid?: string;
  markerUid?: string;
  nonce: string;
};
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw Error("State directory must be an owned regular directory.");
  await chmod(path, 0o700);
}
export async function atomicJson(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  await rename(path + ".tmp", path);
}
export function environment(t: OwnedTarget) {
  return { ...process.env, MINIKUBE_HOME: t.home, KUBECONFIG: t.kubeconfig };
}
export const minikubeBinary = () =>
  process.env.WAYPOINT_MINIKUBE_BIN ?? "minikube";
export const kubeArgs = (t: OwnedTarget, args: string[]) => [
  "--kubeconfig",
  t.kubeconfig,
  "--context",
  t.profile,
  "--request-timeout=20s",
  ...args,
];
export const kube = (
  t: OwnedTarget,
  args: string[],
  input?: string,
  timeout = 30000,
) => run("kubectl", kubeArgs(t, args), { input, timeout, env: environment(t) });
export async function configIdentity(t: OwnedTarget) {
  const s = await lstat(t.kubeconfig);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw Error("Private kubeconfig ownership/permissions changed.");
  const c = object(parse(await readFile(t.kubeconfig, "utf8"))),
    contexts = list(c.contexts),
    clusters = list(c.clusters),
    users = list(c.users);
  if (
    contexts.length !== 1 ||
    clusters.length !== 1 ||
    users.length !== 1 ||
    c["current-context"] !== t.profile ||
    contexts[0].name !== t.profile ||
    at(contexts[0], "context", "cluster") !== clusters[0].name ||
    at(contexts[0], "context", "user") !== users[0].name
  )
    throw Error("Private kubeconfig mapping changed.");
  const cluster = object(clusters[0].cluster),
    user = object(users[0].user),
    url = new URL(text(cluster.server));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    cluster["insecure-skip-tls-verify"] ||
    !cluster["certificate-authority-data"] ||
    user.exec ||
    user["auth-provider"] ||
    user.token ||
    user["client-key"] ||
    user["client-certificate"] ||
    !user["client-key-data"] ||
    !user["client-certificate-data"]
  )
    throw Error(
      "Only pinned TLS and embedded owned credentials are supported.",
    );
  return {
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          profile: t.profile,
          server: cluster.server,
          ca: cluster["certificate-authority-data"],
        }),
      )
      .digest("hex"),
    cluster,
    user,
  };
}
async function driverIdentity(t: OwnedTarget) {
  const c = list(JSON.parse(await run("docker", ["inspect", t.profile])))[0];
  if (
    at(c, "Config", "Labels", "name.minikube.sigs.k8s.io") !== t.profile ||
    at(c, "Config", "Labels", "created_by.minikube.sigs.k8s.io") !== "true"
  )
    throw Error("Minikube Docker ownership labels changed.");
  return text(c.Id);
}
export async function assertOwned(t: OwnedTarget, namespace = true) {
  if (!t.containerId || !t.fingerprint || !t.clusterUid)
    throw Error(
      "Cluster ownership not established. Refusing mutation or cleanup.",
    );
  if (
    (await driverIdentity(t)) !== t.containerId ||
    (await configIdentity(t)).fingerprint !== t.fingerprint
  )
    throw Error("Owned cluster identity changed.");
  const system = JSON.parse(
    await kube(t, ["get", "namespace", "kube-system", "-o", "json"]),
  );
  if (at(system, "metadata", "uid") !== t.clusterUid)
    throw Error("Cluster UID changed.");
  if (namespace) {
    const ns = JSON.parse(
      await kube(t, ["get", "namespace", t.namespace, "-o", "json"]),
    );
    const marker = JSON.parse(
      await kube(t, [
        "-n",
        t.namespace,
        "get",
        "configmap",
        "waypoint-ownership",
        "-o",
        "json",
      ]),
    );
    if (
      at(ns, "metadata", "uid") !== t.namespaceUid ||
      at(marker, "metadata", "uid") !== t.markerUid ||
      at(marker, "data", "nonce") !== t.nonce
    )
      throw Error("Lab namespace or ownership marker changed.");
  }
}
export async function createCluster(t: OwnedTarget, save: () => Promise<void>) {
  await privateDirectory(t.home);
  try {
    await lstat(join(t.home, ".minikube", "profiles", t.profile));
    throw Error("Profile already exists; refusing adoption.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Refuse even a same-named Docker container outside our private Minikube home.
  const existing = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (existing.split("\n").includes(t.profile))
    throw Error("Docker profile-name collision; refusing creation.");
  let creating = true;
  const receipt = (async () => {
    while (creating && !t.containerId) {
      try {
        t.containerId = await driverIdentity(t);
        await save();
      } catch {}
      if (!t.containerId)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  try {
    await run(
      minikubeBinary(),
      [
        "start",
        "--profile",
        t.profile,
        "--driver=docker",
        "--keep-context",
        "--cpus=2",
        "--memory=4096mb",
        "--disk-size=10g",
      ],
      { env: environment(t), timeout: 600000, limit: 200000 },
    );
  } finally {
    creating = false;
    await receipt;
  }
  await completeOwnership(t, save);
}
export async function completeOwnership(
  t: OwnedTarget,
  save: () => Promise<void>,
) {
  if (!t.containerId || (await driverIdentity(t)) !== t.containerId)
    throw Error(
      "Creation has no matching immutable driver receipt; automatic recovery refused.",
    );
  if (!t.fingerprint) {
    const flattened = object(
      parse(await kube(t, ["config", "view", "--flatten", "--raw"])),
    );
    flattened["current-context"] = t.profile;
    await writeFile(t.kubeconfig, stringify(flattened), { mode: 0o600 });
    await chmod(t.kubeconfig, 0o600);

    t.fingerprint = (await configIdentity(t)).fingerprint;
    t.clusterUid = text(
      at(
        JSON.parse(
          await kube(t, ["get", "namespace", "kube-system", "-o", "json"]),
        ),
        "metadata",
        "uid",
      ),
    );
    await save();
  } else if ((await configIdentity(t)).fingerprint !== t.fingerprint)
    throw Error("Pinned TLS identity changed; recovery refused.");
  if (!t.clusterUid) {
    t.clusterUid = text(
      at(
        JSON.parse(
          await kube(t, ["get", "namespace", "kube-system", "-o", "json"]),
        ),
        "metadata",
        "uid",
      ),
    );
    await save();
  }
  await assertOwned(t, false);
  if (!t.namespaceUid) {
    const ns = JSON.parse(
      await kube(t, ["create", "namespace", t.namespace, "-o", "json"]),
    );
    t.namespaceUid = text(at(ns, "metadata", "uid"));
    await save();
  } else {
    const ns = JSON.parse(
      await kube(t, ["get", "namespace", t.namespace, "-o", "json"]),
    );
    if (at(ns, "metadata", "uid") !== t.namespaceUid)
      throw Error("Namespace UID changed; recovery refused.");
  }
  if (!t.markerUid) {
    const marker = JSON.parse(
      await kube(t, [
        "-n",
        t.namespace,
        "create",
        "configmap",
        "waypoint-ownership",
        "--from-literal=nonce=" + t.nonce,
        "-o",
        "json",
      ]),
    );
    t.markerUid = text(at(marker, "metadata", "uid"));
    await save();
  }
  await assertOwned(t);
}
export async function deleteCluster(t: OwnedTarget) {
  await assertOwned(t, false);
  if (t.namespaceUid) {
    const ns = JSON.parse(
      await kube(t, ["get", "namespace", t.namespace, "-o", "json"]),
    );
    if (at(ns, "metadata", "uid") !== t.namespaceUid)
      throw Error("Namespace identity changed; cleanup refused.");
  }
  if (t.markerUid) {
    await assertOwned(t);
  }
  await run(minikubeBinary(), ["delete", "--profile", t.profile], {
    env: environment(t),
    timeout: 120000,
  });
}

export async function assertNeverCreated(t: OwnedTarget) {
  if (t.containerId || t.fingerprint || t.clusterUid)
    throw Error("A created cluster requires verified cleanup.");
  const names = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (names.split("\n").includes(t.profile))
    throw Error(
      "Profile container exists without a recorded receipt; refusing to abandon it.",
    );
  for (const path of [
    t.kubeconfig,
    join(t.home, ".minikube", "profiles", t.profile),
  ]) {
    try {
      await lstat(path);
      throw Error(
        "Partial cluster files exist without verified identity; recovery requires the original receipt.",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
