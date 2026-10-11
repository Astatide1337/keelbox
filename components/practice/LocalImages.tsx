"use client";
import { useMemo, useState } from "react";
import { useAccount } from "../auth/AccountProvider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { parseSources } from "@/lib/domain/importer";
import { at, list, text } from "@/lib/domain/types";
import type { Snapshot } from "@/lib/domain/snapshot";
export function LocalImages({
  project,
  onSaved,
}: {
  project: Snapshot;
  onSaved: () => void;
}) {
  const { request } = useAccount();
  const images = useMemo(
    () => [
      ...new Set(
        parseSources(project.files).resources.flatMap((r) => {
          const spec =
            r.kind === "Pod"
              ? r.raw.spec
              : r.kind === "CronJob"
                ? at(r.raw, "spec", "jobTemplate", "spec", "template", "spec")
                : at(r.raw, "spec", "template", "spec");
          return [
            ...list(at(spec, "containers")),
            ...list(at(spec, "initContainers")),
          ]
            .map((c) => text(c.image))
            .filter(Boolean);
        }),
      ),
    ],
    [project],
  );
  const [original, setOriginal] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await request("/api/project");
      const data = await response.json();
      if (!response.ok || data.selected?.project.id !== project.id)
        throw Error("Selected project changed. Refresh before mapping images.");
      const result = await request("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectRevision: data.selected.revision,
          image: { original: original || images[0], reference },
        }),
      });
      const outcome = await result.json();
      if (!result.ok) throw Error(outcome.error);
      setMessage(
        "Image selected. Review the updated deployment diff before creating the lab.",
      );
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <h3 className="font-medium">Use a local Docker image</h3>
      <p className="text-sm text-muted-foreground">
        Load an image you already pulled into the owned cluster. No registry
        credentials are copied and no image is built.
      </p>
      <Select value={original || images[0]} onValueChange={setOriginal}>
        <SelectTrigger aria-label="Application image">
          <SelectValue placeholder="Application image" />
        </SelectTrigger>
        <SelectContent>
          {images.map((i) => (
            <SelectItem key={i} value={i}>
              {i}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="Local Docker image tag"
        placeholder="Local Docker image tag, e.g. my-app:latest"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      <Button disabled={busy || !reference || !images.length} onClick={save}>
        Use local image
      </Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
