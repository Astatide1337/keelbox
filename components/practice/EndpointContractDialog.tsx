"use client";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  importSnapshot,
  projectResources,
  type Snapshot,
} from "@/lib/domain/snapshot";
import { at, list } from "@/lib/domain/types";
export function EndpointContractDialog({
  open,
  onOpenChange,
  source,
  onDeclare,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  source: Snapshot;
  onDeclare: (s: Snapshot) => Promise<void>;
}) {
  const workloads = projectResources(source).filter(
    (r) => r.kind === "Deployment",
  );
  const [selected, setSelected] = useState(""),
    [path, setPath] = useState("/healthz"),
    [port, setPort] = useState("8080"),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure practice</DialogTitle>
          <DialogDescription>
            Set a known healthy endpoint for this application. Waypoint verifies
            it through the Service inside the owned local lab. The source
            cluster remains unchanged.
          </DialogDescription>
        </DialogHeader>
        {source.contracts.map((c, i) => (
          <p key={i}>
            {c.namespace}/{c.deployment} · {c.container} · HTTP {c.path} on port{" "}
            {c.port}
          </p>
        ))}
        <label htmlFor="contract-workload">Workload</label>
        <Select
          value={
            workloads.some((w) => w.id === selected)
              ? selected
              : workloads[0]?.id
          }
          onValueChange={setSelected}
        >
          <SelectTrigger id="contract-workload" aria-label="Contract workload">
            <SelectValue placeholder="No Deployment available" />
          </SelectTrigger>
          <SelectContent>
            {workloads.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.namespace}/{r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label htmlFor="endpoint-path">Known healthy HTTP path</label>
        <Input
          id="endpoint-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <label htmlFor="endpoint-port">HTTP port</label>
        <Input
          id="endpoint-port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        {error && (
          <div role="alert" className="notice">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={!workloads.length || saving}
            onClick={async () => {
              const d =
                  workloads.find((r) => r.id === selected) ?? workloads[0],
                containers = list(
                  at(d.raw, "spec", "template", "spec", "containers"),
                );
              const n = Number(port);
              if (
                containers.length !== 1 ||
                !path.startsWith("/") ||
                path.includes("?") ||
                !Number.isInteger(n) ||
                n < 1 ||
                n > 65535
              ) {
                setError(
                  "Choose a single-container workload and a valid HTTP path/port.",
                );
                return;
              }
              setError("");
              setSaving(true);
              try {
                await onDeclare(
                  importSnapshot(
                    JSON.stringify({
                      ...source,
                      contracts: [
                        ...source.contracts.filter(
                          (c) =>
                            c.namespace !== d.namespace ||
                            c.deployment !== d.name ||
                            c.container !== containers[0].name,
                        ),
                        {
                          deployment: d.name,
                          namespace: d.namespace,
                          container: containers[0].name,
                          path,
                          port: n,
                        },
                      ],
                    }),
                  ),
                );
                onOpenChange(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Declare supported endpoint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
