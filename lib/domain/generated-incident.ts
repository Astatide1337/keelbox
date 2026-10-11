import { safeText, sanitizeTutorValue } from "../tutor/context";
import { z } from "zod";
import {
  digest,
  type DeploymentPlan,
  type HttpContract,
} from "./deployment-plan";
export const recipeSchema = z
  .object({
    title: z.string().min(5).max(100),
    symptom: z.string().min(10).max(500),
    objective: z.string().min(10).max(500),
    incident: z.enum(["readiness", "liveness"]),
    target: z.string().max(800),
    hints: z.array(z.string().min(5).max(500)).length(3),
    grader: z
      .array(
        z.enum([
          "baseline-configuration",
          "replicas-ready",
          "ready-backends",
          "service-http",
          "restart-stable",
        ]),
      )
      .min(4)
      .max(5),
  })
  .strict();
export type IncidentRecipe = z.infer<typeof recipeSchema>;
export const targetKey = (c: HttpContract, namespace: string) =>
  [c.namespace ?? namespace, c.deployment, c.container].join("/");
export function validateRecipe(
  value: unknown,
  plan: DeploymentPlan,
): IncidentRecipe {
  const recipe = recipeSchema.parse(value),
    target = (plan.contracts ?? (plan.contract ? [plan.contract] : [])).find(
      (c) => targetKey(c, plan.namespace) === recipe.target,
    );
  if (!target)
    throw Error("Generated incident targets an unavailable workload.");
  if (recipe.incident === "liveness" && !target.livenessPath)
    throw Error(
      "Generated liveness incident requires an existing HTTP liveness probe.",
    );
  const required = [
    "baseline-configuration",
    "replicas-ready",
    "ready-backends",
    "service-http",
    ...(recipe.incident === "liveness" ? ["restart-stable"] : []),
  ];
  if (
    required.some(
      (k) => !recipe.grader.includes(k as IncidentRecipe["grader"][number]),
    ) ||
    recipe.grader.length !== required.length ||
    new Set(recipe.grader).size !== recipe.grader.length
  )
    throw Error(
      "Generated grader omits required recovery checks or contains duplicate checks.",
    );
  return recipe;
}
export function recipeEvidence(plan: DeploymentPlan) {
  const context = sanitizeTutorValue({
    purpose:
      "Design one real probe-failure investigation in an owned local Kubernetes cluster.",
    targets: (plan.contracts ?? (plan.contract ? [plan.contract] : [])).map(
      (c) => ({
        target: targetKey(c, plan.namespace),
        deployment: c.deployment,
        container: c.container,
        service: c.service,
        readinessPath: safeText(c.path),
        livenessPath: safeText(c.livenessPath),
        servicePort: c.port,
      }),
    ),
    constraints: {
      faults: ["readiness", "liveness"],
      faultEffect:
        "Waypoint changes only the selected HTTP probe path to a nonexistent path and requires real corroborating kubelet events and readiness/restart symptoms.",
      repair:
        "Restore the baseline probe path while preserving replicas, required probes, images and configuration.",
      grader: [
        "baseline-configuration",
        "replicas-ready",
        "ready-backends",
        "service-http",
        "restart-stable",
      ],
      mandatory:
        "First four checks always required; restart-stable also required for liveness. Grader is a typed check list, never executable code.",
      output:
        "Return ONLY JSON matching the response schema. incident must be exactly readiness or liveness. target must be one of the target strings above, not an object. grader must contain the exact required check identifiers, not sentences. Start with symptoms; do not reveal the probe path solution in the title or symptom.",
    },
  });
  return { context, digest: digest(context) };
}
