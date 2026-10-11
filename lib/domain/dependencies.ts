import { at, list, object, text, type ObjectMap } from "./types";

export type DependencyRef = {
  kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim" | "ServiceAccount";
  name: string;
  keys: string[];
  optional: boolean;
  path: string;
};
/** One dependency grammar for planning, diagnostics and capability reporting. */
export function podDependencies(pod: ObjectMap): DependencyRef[] {
  const refs: DependencyRef[] = [];
  const add = (
    kind: DependencyRef["kind"],
    value: unknown,
    nameKey: string,
    path: string,
    keys: string[] = [],
  ) => {
    const ref = object(value),
      name = text(ref[nameKey]);
    if (name)
      refs.push({ kind, name, keys, optional: ref.optional === true, path });
  };
  for (const field of ["containers", "initContainers"])
    list(pod[field]).forEach((container, index) => {
      for (const [envIndex, env] of list(container.env).entries()) {
        add(
          "Secret",
          at(env, "valueFrom", "secretKeyRef"),
          "name",
          `${field}.${index}.env.${envIndex}.valueFrom.secretKeyRef`,
          [text(at(env, "valueFrom", "secretKeyRef", "key"))].filter(Boolean),
        );
        add(
          "ConfigMap",
          at(env, "valueFrom", "configMapKeyRef"),
          "name",
          `${field}.${index}.env.${envIndex}.valueFrom.configMapKeyRef`,
          [text(at(env, "valueFrom", "configMapKeyRef", "key"))].filter(
            Boolean,
          ),
        );
      }
      for (const [envIndex, env] of list(container.envFrom).entries()) {
        add("Secret", env.secretRef, "name", `${field}.${index}.envFrom`);
        add("ConfigMap", env.configMapRef, "name", `${field}.${index}.envFrom`);
      }
    });
  list(pod.volumes).forEach((volume, index) => {
    const keys = (value: unknown) =>
      list(at(value, "items"))
        .map((item) => text(item.key))
        .filter(Boolean);
    add(
      "Secret",
      volume.secret,
      "secretName",
      `volumes.${index}.secret`,
      keys(volume.secret),
    );
    add(
      "ConfigMap",
      volume.configMap,
      "name",
      `volumes.${index}.configMap`,
      keys(volume.configMap),
    );
    add(
      "PersistentVolumeClaim",
      volume.persistentVolumeClaim,
      "claimName",
      `volumes.${index}.persistentVolumeClaim`,
    );
    for (const [projectedIndex, projected] of list(
      at(volume, "projected", "sources"),
    ).entries()) {
      add(
        "Secret",
        projected.secret,
        "name",
        `volumes.${index}.projected.sources.${projectedIndex}.secret`,
        keys(projected.secret),
      );
      add(
        "ConfigMap",
        projected.configMap,
        "name",
        `volumes.${index}.projected.sources.${projectedIndex}.configMap`,
        keys(projected.configMap),
      );
    }
  });
  for (const [index, pull] of list(pod.imagePullSecrets).entries())
    add("Secret", pull, "name", `imagePullSecrets.${index}`);
  if (pod.serviceAccountName && pod.serviceAccountName !== "default")
    add(
      "ServiceAccount",
      { name: pod.serviceAccountName },
      "name",
      "serviceAccountName",
    );
  return refs;
}
export function secretKeyMetadata(resource: ObjectMap): string[] {
  let annotated: unknown = [];
  try {
    annotated = JSON.parse(
      text(
        at(resource, "metadata", "annotations", "waypoint.dev/secret-keys"),
      ) || "[]",
    );
  } catch {}
  return [
    ...new Set([
      ...Object.keys(object(resource.data)),
      ...Object.keys(object(resource.stringData)),
      ...(Array.isArray(annotated)
        ? annotated.filter((key): key is string => typeof key === "string")
        : []),
    ]),
  ];
}
