"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../ui/select";
import { useAccount } from "../auth/AccountProvider";
import type {
  IncidentRecipe,
  recipeEvidence,
} from "@/lib/domain/generated-incident";
import {
  incidentChoice,
  type LiveIncidentChoice,
} from "@/lib/domain/live-incidents";
export function GenerateIncident({
  lab,
  busy,
  available,
  onStart,
}: {
  lab: { id: string; generation: number; revision: number };
  busy: boolean;
  available: LiveIncidentChoice[];
  onStart: (recipe: IncidentRecipe, id: string) => void;
}) {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [model, setModel] = useState(""),
    [preview, setPreview] = useState<ReturnType<typeof recipeEvidence> | null>(
      null,
    ),
    [proposal, setProposal] = useState<{
      id: string;
      recipe: IncidentRecipe;
    } | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const version = {
    sessionId: lab.id,
    generation: lab.generation,
    revision: lab.revision,
  };
  async function prepare() {
    setPending(true);
    setError("");
    try {
      const [p, m] = await Promise.all([
        account.request("/api/incidents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "preview", ...version }),
        }),
        account.request("/api/auth?models=1"),
      ]);
      const pd = await p.json(),
        md = await m.json();
      if (!p.ok) throw Error(pd.error);
      if (!m.ok) throw Error(md.error);
      setPreview(pd);
      setModels(md.models);
      setModel(md.models[0]?.id ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function generate() {
    setPending(true);
    setError("");
    try {
      const r = await account.request("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "generate",
          ...version,
          model,
          digest: preview?.digest,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setProposal(d.proposal);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          disabled={busy || !available.length || !account.status?.planEnabled}
          onClick={() => {
            if (!preview && !pending) void prepare();
          }}
        >
          Create with ChatGPT
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {proposal
              ? proposal.recipe.title
              : "Create an exercise with ChatGPT"}
          </DialogTitle>
          <DialogDescription>
            {proposal
              ? proposal.recipe.symptom
              : "Review the application information, then generate a problem to investigate."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!preview ? (
          <>
            {pending ? (
              <p role="status">Loading application summary…</p>
            ) : (
              <Button disabled={busy || pending} onClick={prepare}>
                Try again
              </Button>
            )}
          </>
        ) : !proposal ? (
          <>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Application information shared with OpenAI
              </summary>
              <div className="mt-3 space-y-4 text-sm">
                {preview.context.targets.map((target) => (
                  <div key={target.target}>
                    <strong>
                      {target.deployment} / {target.container}
                    </strong>
                    <p className="text-muted-foreground">{target.target}</p>
                    <p>
                      Service: {target.service}:{target.servicePort}
                    </p>
                    <p>
                      Readiness: {target.readinessPath}
                      {target.livenessPath
                        ? `; liveness: ${target.livenessPath}`
                        : ""}
                    </p>
                    <p>
                      Exercises:{" "}
                      {target.incidents.map((i) => i.title).join(", ")}
                    </p>
                  </div>
                ))}
              </div>
            </details>
            <p className="text-sm text-muted-foreground">
              An application summary is shared. Secret values, configuration
              contents, and logs are excluded.
            </p>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger aria-label="Incident model">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={busy || pending || !model} onClick={generate}>
              {pending ? "Creating exercise…" : "Generate exercise"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm">{proposal.recipe.objective}</p>
            <p className="text-sm">
              Workload:{" "}
              <strong>
                {proposal.recipe.target.split("/").slice(1).join(" / ")}
              </strong>
            </p>
            <p className="text-sm text-muted-foreground">
              {incidentChoice(proposal.recipe.incident).title} will be
              introduced in your local lab.
            </p>
            <details className="text-sm">
              <summary>What changes</summary>
              <p className="mt-3">
                {incidentChoice(proposal.recipe.incident).operation}
              </p>
              <p className="mt-2">
                Repair: {incidentChoice(proposal.recipe.incident).repair}
              </p>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || pending}
                onClick={() => setProposal(null)}
              >
                Try another
              </Button>
              <Button
                disabled={busy || pending}
                onClick={() => {
                  setOpen(false);
                  onStart(proposal.recipe, proposal.id);
                }}
              >
                Start generated investigation
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
