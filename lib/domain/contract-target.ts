import type { HttpContract } from "./deployment-plan";

export const targetKey = (contract: HttpContract, namespace: string) =>
  [
    contract.namespace ?? namespace,
    contract.deployment,
    contract.container,
  ].join("/");
