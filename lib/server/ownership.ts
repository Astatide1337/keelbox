import { createHash } from "node:crypto";
import { at, list, object, text } from "../domain/types";
export function kubeconfigIdentity(value: unknown, clusterName: string) {
  const config = object(value),
    expected = "kind-" + clusterName;
  const clusters = list(config.clusters),
    contexts = list(config.contexts),
    users = list(config.users);
  if (
    clusters.length !== 1 ||
    contexts.length !== 1 ||
    users.length !== 1 ||
    clusters[0].name !== expected ||
    contexts[0].name !== expected ||
    users[0].name !== expected ||
    config["current-context"] !== expected ||
    at(contexts[0], "context", "cluster") !== expected ||
    at(contexts[0], "context", "user") !== expected
  )
    throw new Error(
      "Dedicated kubeconfig context mapping changed. Refusing cluster access.",
    );
  const cluster = object(clusters[0].cluster),
    user = object(users[0].user);
  const server = new URL(text(cluster.server));
  if (
    server.protocol !== "https:" ||
    server.hostname !== "127.0.0.1" ||
    !text(cluster["certificate-authority-data"]) ||
    cluster["insecure-skip-tls-verify"] ||
    user.exec ||
    user["auth-provider"] ||
    user["client-certificate"] ||
    user["client-key"] ||
    !text(user["client-certificate-data"]) ||
    !text(user["client-key-data"])
  )
    throw new Error(
      "Owned kubeconfig must use loopback TLS with embedded kind credentials.",
    );
  return createHash("sha256")
    .update(
      expected +
        "\n" +
        server.href +
        "\n" +
        text(cluster["certificate-authority-data"]),
    )
    .digest("hex");
}
