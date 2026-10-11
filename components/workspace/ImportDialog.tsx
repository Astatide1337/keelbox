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
import {
  manifestProject,
  importSnapshot,
  type Snapshot,
} from "@/lib/domain/snapshot";
import { parseSources } from "@/lib/domain/importer";
export function ImportDialog({
  open,
  onOpenChange,
  onProject,
  error,
  onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onProject: (source: Snapshot) => void | Promise<void>;
  error: string;
  onError: (message: string) => void;
}) {
  const [paste, setPaste] = useState("");
  const [preview, setPreview] = useState<Snapshot | null>(null);
  const [saving, setSaving] = useState(false);
  function review(content: string, name = "imported.yaml") {
    if (!content.trim())
      throw Error("Choose a file or paste Kubernetes manifests.");
    if (new TextEncoder().encode(content).length > 2_000_000)
      throw Error("Import exceeds 2 MB.");
    if (
      content.trim().startsWith("{") &&
      content.includes("playground-snapshot-")
    ) {
      setPreview(importSnapshot(content));
      return;
    }
    const files = [{ id: crypto.randomUUID(), name, content }],
      parsed = parseSources(files);
    if (parsed.diagnostics.length)
      throw Error(
        parsed.diagnostics
          .map((d) => `Line ${d.line}: ${d.message}`)
          .join("\n"),
      );
    if (!parsed.resources.length) throw Error("No Kubernetes resources found.");
    if (parsed.resources.some((r) => r.kind === "Secret"))
      throw Error(
        "Remove Secret values before browser import. The CLI can sanitize Secret key metadata.",
      );
    setPreview(manifestProject(files));
  }
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import project</DialogTitle>
          <DialogDescription>
            Import YAML, JSON, or a CLI snapshot for inspection. Deployment
            happens only after a separate local lab review. Remove credentials
            first.
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
              setPreview(null);
              onError("");
              if (
                selected.length > 100 ||
                selected.reduce((n, f) => n + f.size, 0) > 2_000_000
              )
                throw Error("Import is limited to 100 files and 2 MB total.");
              if (selected.length === 1) {
                review(await selected[0].text(), selected[0].name);
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
                if (!parsed.resources.length)
                  throw Error("No Kubernetes resources found in these files.");
                if (parsed.resources.some((r) => r.kind === "Secret"))
                  throw Error("Remove Secret resources before browser import.");
                setPreview(manifestProject(files));
              }
            } catch (e) {
              onError((e as Error).message);
            } finally {
              if (input.current) input.current.value = "";
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
        {preview && (
          <div role="status" className="text-sm">
            <strong>{preview.label}</strong>
            <p>
              {preview.files.length} manifest files ·{" "}
              {preview.origin === "captured"
                ? `${preview.resources.length} captured resources`
                : `${parseSources(preview.files).resources.length} declared resources`}
            </p>
            <p>
              Import for inspection only. Existing project drafts remain
              available in the project menu.
            </p>
            <Button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await onProject(preview);
                  setPreview(null);
                } catch (e) {
                  onError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Importing…" : "Confirm import"}
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel preview
            </Button>
          </div>
        )}
        <label htmlFor="paste-yaml">Paste manifests or snapshot JSON</label>
        <Textarea
          id="paste-yaml"
          className="paste-input"
          value={paste}
          onChange={(e) => {
            setPaste(e.target.value);
            setPreview(null);
          }}
        />
        <DialogFooter>
          <Button
            onClick={() => {
              try {
                onError("");
                review(paste);
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            Review pasted content
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
