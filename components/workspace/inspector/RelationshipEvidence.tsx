"use client";
import { Button } from "@/components/ui/button";
import type {
  Relationship,
  EvidenceRef,
  SourceFile,
  Resource,
} from "@/lib/domain/types";
export function RelationshipEvidence({
  relationships,
  resources,
  resourceId,
  files,
  onEvidence,
  onResource,
  focusId,
}: {
  relationships: Relationship[];
  resources: Resource[];
  resourceId: string;
  files: SourceFile[];
  onEvidence: (ref: EvidenceRef) => void;
  onResource: (id: string) => void;
  focusId?: string | null;
}) {
  const visible = focusId
    ? relationships.filter((rel) => rel.id === focusId)
    : relationships;
  return (
    <div className="space-y-4">
      {visible.map((rel) => {
        const otherId = rel.from === resourceId ? rel.to : rel.from;
        const other = resources.find((resource) => resource.id === otherId);
        return (
          <div key={rel.id} className="border-b pb-4 last:border-b-0">
            <p className="text-sm text-muted-foreground">{rel.title}</p>
            {other ? (
              <Button
                variant="link"
                className="h-auto max-w-full justify-start whitespace-normal px-0 text-left"
                onClick={() => onResource(other.id)}
              >
                {other.kind} / {other.name}
              </Button>
            ) : (
              <p className="text-sm">Related resource unavailable</p>
            )}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                View evidence
              </summary>
              <p className="my-2">{rel.explanation}</p>
              <div className="flex flex-col items-start gap-1">
                {rel.evidence.map((ref, i) => {
                  const file = files.find((file) => file.id === ref.fileId);
                  return (
                    <Button
                      key={i}
                      variant="link"
                      className="h-auto max-w-full whitespace-normal px-0 text-left"
                      title={ref.path.join(".")}
                      onClick={() => onEvidence(ref)}
                    >
                      {file
                        ? `${file.name} · line ${ref.line}`
                        : `Cluster field · ${ref.path.join(".")}`}
                    </Button>
                  );
                })}
              </div>
            </details>
          </div>
        );
      })}
      {!visible.length && (
        <p className="text-sm text-muted-foreground">
          {focusId
            ? "This relationship is no longer available."
            : "No related resources found."}
        </p>
      )}
    </div>
  );
}
