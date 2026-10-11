"use client";
import { Button } from "../ui/button";
import { SourceEditor, type EditorContext } from "./SourceEditor";
import type { SourceFile, Diagnostic } from "@/lib/domain/types";
export function ManifestFileEditor({
  file,
  projectId,
  dirty,
  diagnostics,
  contexts,
  onEdit,
  onSave,
  onRevert,
  onExport,
  onClose,
}: {
  file: SourceFile;
  projectId: string;
  dirty: boolean;
  diagnostics: Diagnostic[];
  contexts: Map<string, EditorContext>;
  onEdit: (id: string, value: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  return (
    <section className="h-full flex min-h-0 flex-col">
      <div className="p-3 border-b flex flex-wrap items-center gap-2">
        <strong className="w-full min-w-0 truncate" title={file.name}>
          {file.name.split(/[\\/]/).pop()}
        </strong>
        <Button
          size="sm"
          className="md:hidden"
          variant="ghost"
          onClick={onClose}
        >
          Back to files
        </Button>
        <span className="text-xs text-muted-foreground">
          {dirty ? "Unsaved draft" : "Saved draft"}
        </span>
        <Button
          size="sm"
          disabled={!dirty || diagnostics.length > 0}
          onClick={onSave}
        >
          Save draft
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty}
          onClick={onRevert}
        >
          Revert
        </Button>
        <Button size="sm" variant="ghost" onClick={onExport}>
          Export draft
        </Button>
      </div>
      {diagnostics.length > 0 && (
        <p role="alert" className="notice">
          Invalid YAML · text retained. {diagnostics[0].message}
        </p>
      )}
      <div className="flex-1 min-h-0">
        <SourceEditor
          contextKey={`${projectId}:${file.id}`}
          contexts={contexts}
          value={file.content}
          onChange={(value) => onEdit(file.id, value)}
          ranges={[]}
        />
      </div>
    </section>
  );
}
