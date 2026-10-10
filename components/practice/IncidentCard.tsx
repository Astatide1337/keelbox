"use client";
import { TriangleAlert, RefreshCw, PanelsTopLeft } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { incidents } from "@/lib/practice/scenarios/catalog";
export const incidentLevels = {
  readiness: "Beginner",
  liveness: "Intermediate",
  http503: "Intermediate",
} as const;
export function IncidentCard({
  incident,
  supported,
  busy,
  onStart,
}: {
  incident: (typeof incidents)[number];
  supported: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const Icon =
    incident.id === "readiness"
      ? TriangleAlert
      : incident.id === "liveness"
        ? RefreshCw
        : PanelsTopLeft;
  return (
    <Card className={`incident ${incident.id}`}>
      <CardHeader>
        <div className="incident-icon">
          <Icon />
        </div>
        <CardTitle>
          {
            {
              readiness: "Readiness probe failure",
              liveness: "Liveness probe failure",
              http503: "HTTP 503",
            }[incident.id]
          }
        </CardTitle>
        <CardDescription>{incident.symptom}</CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible>
          <AccordionItem value="details">
            <AccordionTrigger>
              Objective & prerequisites{!supported ? " · review required" : ""}
            </AccordionTrigger>
            <AccordionContent>
              <span className="section-label">Learning objective</span>
              <p>{incident.objective}</p>
              <span className="section-label">Prerequisites</span>
              <p>{incident.requires}</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
      <CardFooter>
        <span className="incident-level">
          <span
            className="status-dot"
            style={{
              background:
                incident.id === "readiness"
                  ? "var(--success)"
                  : "var(--warning)",
            }}
          />
          {incidentLevels[incident.id]}
        </span>
        <Button disabled={busy} onClick={onStart}>
          {busy
            ? "Preparing copy…"
            : supported
              ? "Begin investigation"
              : "Review prerequisites"}
        </Button>
      </CardFooter>
    </Card>
  );
}
