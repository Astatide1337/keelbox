"use client";
import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { manifestProject, type Snapshot } from "@/lib/domain/snapshot";
import { parseSources } from "@/lib/domain/importer";
export function ImportDialog({
  open,
  onOpenChange,
  onContent,
  onProject,
  error,
  onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onContent: (content: string, name?: string) => void;
  onProject: (source: Snapshot) => void;
  error: string;
  onError: (message: string) => void;
}) {
  const [paste, setPaste] = useState("");
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import project</DialogTitle>
          <DialogDescription>
            Import authored YAML or a read-only CLI snapshot. Imported workloads
            are never run. Remove credentials before importing files.
          </DialogDescription>
        </DialogHeader>
        <input
          ref={input}
          type="file"
          accept=".yaml,.yml,.json"
          multiple
          className="sr-only"
          aria-label="Project files"
          onChange={async (e) => {
            try {
              const selected = [...(e.target.files ?? [])];
              if (!selected.length) return;
              if (
                selected.length > 100 ||
                selected.reduce((n, f) => n + f.size, 0) > 2_000_000
              )
                throw Error("Import is limited to 100 files and 2 MB total.");
              if (selected.length === 1) {
                onContent(await selected[0].text(), selected[0].name);
              } else {
                const files = await Promise.all(
                  selected.map(async (f) => ({
                    id: crypto.randomUUID(),
                    name: f.name,
                    content: await f.text(),
                  })),
                );
                const parsed = parseSources(files);
                if (parsed.diagnostics.length)
                  throw Error(parsed.diagnostics[0].message);
                if (parsed.resources.some((r) => r.kind === "Secret"))
                  throw Error("Remove Secret resources before browser import.");
                onProject(manifestProject(files));
              }
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        />
        <Button variant="outline" onClick={() => input.current?.click()}>
          Choose files
        </Button>
        {error && (
          <div role="alert" className="notice">
            {error}
          </div>
        )}
        <label htmlFor="paste-yaml">Paste manifests or snapshot JSON</label>
        <Textarea
          id="paste-yaml"
          className="paste-input"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <DialogFooter>
          <Button onClick={() => onContent(paste)}>
            Import pasted content
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
