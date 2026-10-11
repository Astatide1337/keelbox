"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "../ui/card";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../ui/select";
import { useAccount } from "../auth/AccountProvider";
import type { IncidentRecipe } from "@/lib/domain/generated-incident";
export function GenerateIncident({
  lab,
  busy,
  onStart,
}: {
  lab: { id: string; generation: number; revision: number };
  busy: boolean;
  onStart: (recipe: IncidentRecipe, id: string) => void;
}) {
  const account = useAccount();
  const [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [model, setModel] = useState(""),
    [preview, setPreview] = useState<{
      digest: string;
      context: unknown;
    } | null>(null),
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
    <Card>
      <CardHeader>
        <CardTitle>Create an incident with ChatGPT</CardTitle>
        <CardDescription>
          Design an investigation around this application’s probes and Services.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {!preview ? (
          <Button
            disabled={busy || pending || !account.status?.planEnabled}
            onClick={prepare}
          >
            Review application summary
          </Button>
        ) : !proposal ? (
          <>
            <details>
              <summary>Summary sent to OpenAI</summary>
              <pre className="max-h-52 overflow-auto text-xs">
                {JSON.stringify(preview.context, null, 2)}
              </pre>
            </details>
            <p className="text-sm text-muted-foreground">
              Only this summary is sent. Secret values, configuration contents
              and logs are excluded.
            </p>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger aria-label="Incident model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem value={m.id} key={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={busy || pending || !model} onClick={generate}>
              {pending ? "Creating incident…" : "Generate incident"}
            </Button>
          </>
        ) : (
          <>
            <h3 className="font-medium">{proposal.recipe.title}</h3>
            <p>{proposal.recipe.symptom}</p>
            <p className="text-sm text-muted-foreground">
              {proposal.recipe.objective}
            </p>
            <details>
              <summary>Recovery checks</summary>
              <ul>
                {proposal.recipe.grader.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </details>
            <Button
              disabled={busy || pending}
              onClick={() => onStart(proposal.recipe, proposal.id)}
            >
              Start generated investigation
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
