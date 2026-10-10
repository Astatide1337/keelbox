import type { IncidentId } from "../types";
export const incidents: {
  id: IncidentId;
  title: string;
  symptom: string;
  objective: string;
  requires: string;
  hints: string[];
  debrief: string;
}[] = [
  {
    id: "readiness",
    title: "A Pod fails its readiness probe",
    symptom: "The process is running, but the workload stays unavailable.",
    objective:
      "Restore traffic eligibility without disabling the readiness probe.",
    requires:
      "HTTP readiness probe · owner chain · known endpoint · EndpointSlice coverage",
    hints: [
      "Compare Pod conditions with container readiness. Running is not the same as ready.",
      "Correlate the recent kubelet event with the probe in the owner template and the application endpoint contract.",
      "Compare the HTTP readiness path with the healthy path shown in the endpoint contract.",
    ],
    debrief:
      "The modeled process was running, but its readiness HTTP request failed. Pod Ready=false and container readiness=false were corroborated by synthetic Unhealthy events. Repairing the supported path makes the Pods eligible endpoints. In a real incident, correlate current conditions and recent kubelet events, test the health endpoint, then observe the rollout and EndpointSlices.",
  },
  {
    id: "liveness",
    title: "A container repeatedly fails its liveness probe",
    symptom:
      "The container keeps restarting while its process can serve requests.",
    objective:
      "Correlate liveness failures with Killing events and restore a stable container.",
    requires:
      "HTTP liveness probe · known endpoint · restart state · owner chain",
    hints: [
      "A restart count alone does not identify its cause. Inspect the events and container state.",
      "Find consecutive liveness failures followed by kubelet Killing events. Compare the probe with the endpoint contract.",
      "Repair the liveness HTTP path; preserve its threshold and keep it enabled.",
    ],
    debrief:
      "Synthetic Unhealthy events reach the liveness failure threshold, followed by Killing and a restart. The correct liveness path prevents additional modeled restarts over a bounded window. Existing restart history is retained. In a real incident, distinguish probe-triggered restarts from crashes or OOM, correlate timestamps and termination reasons, and observe a sufficiently long stable window.",
  },
  {
    id: "http503",
    title: "An application returns HTTP 503",
    symptom: "The supported gateway responds with “backend unavailable”.",
    objective:
      "Trace the gateway symptom to backend selection and restore its modeled response.",
    requires:
      "Explicit gateway fallback contract · backend Service · ready Pods · EndpointSlices",
    hints: [
      "Identify which component produced the response. A bare Service does not guarantee HTTP 503.",
      "Compare backend Pod readiness and Service selection. Check the intended target UIDs.",
      "Repair the backend Service selector so it matches the intended Pod labels.",
    ],
    debrief:
      "The supported gateway contract explicitly returns 503 when no eligible backend targets exist. The hypothetical selector mismatch left ready Pods unselected. Repairing selection restores intended modeled targets and the gateway response. In a real incident, identify the app/proxy producing 503, inspect its logs and configuration, then verify backend discovery and actual requests. Other 503 causes require other investigations.",
  },
];
