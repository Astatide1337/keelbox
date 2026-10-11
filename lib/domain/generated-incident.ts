import { safeText, sanitizeTutorValue } from "../tutor/context";
import { z } from "zod";
import { digest, type DeploymentPlan } from "./deployment-plan";
import { targetKey } from "./contract-target";
export { targetKey } from "./contract-target";
import {
  applicableIncidents,
  incidentChoice,
  LIVE_INCIDENT_IDS,
  type LiveIncidentId,
} from "./live-incidents";

const graderIds = [
  "baseline-configuration",
  "replicas-ready",
  "ready-backends",
  "service-http",
  "restart-stable",
  "producer-live",
  "feed-sequence-advances",
  "consumer-freshness",
  "consumer-ready-endpoint",
] as const;
export const recipeSchema = z
  .object({
    title: z.string().min(5).max(100),
    symptom: z.string().min(10).max(500),
    objective: z.string().min(10).max(500),
    incident: z.enum(LIVE_INCIDENT_IDS),
    target: z.string().max(800),
    hints: z.array(z.string().min(5).max(500)).length(3),
    grader: z.array(z.enum(graderIds)).min(4).max(9),
  })
  .strict();
export type IncidentRecipe = z.infer<typeof recipeSchema>;

function requiredChecks(incident: LiveIncidentId) {
  return [
    "baseline-configuration",
    "replicas-ready",
    "ready-backends",
    "service-http",
    ...(incident === "liveness" ? ["restart-stable"] : []),
    ...(incident === "market-data-stale"
      ? [
          "producer-live",
          "feed-sequence-advances",
          "consumer-freshness",
          "consumer-ready-endpoint",
        ]
      : []),
  ];
}

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
  const applicable = applicableIncidents(plan, recipe.target).some(
    (choice) => choice.id === recipe.incident,
  );
  if (!applicable)
    throw Error("Generated incident is not applicable to this workload.");
  const required = requiredChecks(recipe.incident);
  if (
    required.some(
      (k) => !recipe.grader.includes(k as IncidentRecipe["grader"][number]),
    ) ||
    recipe.grader.length !== required.length ||
    new Set(recipe.grader).size !== recipe.grader.length
  )
    throw Error(
      "Generated grader differs from the exact code-defined recovery checks.",
    );
  return recipe;
}

export function recipeEvidence(plan: DeploymentPlan) {
  const targets = (plan.contracts ?? (plan.contract ? [plan.contract] : []))
    .map((c) => {
      const target = targetKey(c, plan.namespace);
      return {
        target,
        deployment: c.deployment,
        container: c.container,
        service: c.service,
        readinessPath: safeText(c.path),
        livenessPath: safeText(c.livenessPath),
        servicePort: c.port,
        incidents: applicableIncidents(plan, target).map((choice) => ({
          id: choice.id,
          title: choice.title,
          operation: choice.operation,
          repair: choice.repair,
          requiredChecks: requiredChecks(choice.id),
        })),
      };
    })
    .filter((target) => target.incidents.length > 0);
  const context = sanitizeTutorValue({
    purpose:
      "Design one evidence-led investigation by choosing a code-validated incident and exact workload target.",
    targets,
    constraints: {
      allowedIncidents: LIVE_INCIDENT_IDS,
      faultEffect:
        "The model may select only an incident listed for the exact target. Waypoint derives and displays the validated operation; model text never controls a manifest patch, shell, command, or grader.",
      repair:
        "Use the exact repair named in the selected incident. Restore only the reviewed baseline in the Waypoint-owned disposable lab.",
      grader: graderIds,
      mandatory:
        "Return exactly the code-defined recovery check identifiers listed for the selected incident. Do not invent or omit checks.",
      output:
        "Return ONLY JSON matching the schema. incident must be a listed allowed ID, target an exact target string above, and grader the exact recovery check identifiers for that incident. Describe symptoms without revealing the repair in title or symptom. Never return commands or YAML.",
    },
  });
  return { context, digest: digest(context) };
}

export function incidentRequiredChecks(incident: LiveIncidentId) {
  return requiredChecks(incident);
}

export function incidentCopy(incident: LiveIncidentId) {
  return incidentChoice(incident);
}
