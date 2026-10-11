"use client";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import type { Relationship, EvidenceRef, SourceFile } from "@/lib/domain/types";
export function RelationshipEvidence({
  relationships,
  files,
  onEvidence,
  focusId,
}: {
  relationships: Relationship[];
  files: SourceFile[];
  onEvidence: (ref: EvidenceRef) => void;
  focusId?: string | null;
}) {
  const visible = focusId
    ? relationships.filter((relationship) => relationship.id === focusId)
    : relationships;
  return (
    <Accordion
      type="single"
      collapsible
      key={focusId ?? "relationships"}
      defaultValue={focusId ? "relationships" : undefined}
    >
      <AccordionItem value="relationships">
        <AccordionTrigger>
          Relationship evidence ({visible.length})
        </AccordionTrigger>
        <AccordionContent>
          <p className="muted">
            Inferred from fields. These relationships do not verify live
            traffic.
          </p>
          {visible.map((rel) => (
            <div className="relationship-evidence" key={rel.id}>
              <h3>{rel.title}</h3>
              <p>{rel.explanation}</p>
              {rel.evidence.map((ref, i) => (
                <Button
                  key={i}
                  variant="outline"
                  className="file-row"
                  onClick={() => onEvidence(ref)}
                >
                  {files.find((f) => f.id === ref.fileId)?.name ??
                    "Captured API field"}{" "}
                  · {ref.path.join(".")} · line {ref.line}
                </Button>
              ))}
            </div>
          ))}
          {!visible.length && (
            <p className="muted">
              {focusId
                ? "The selected relationship is no longer available. Select another relationship in the graph."
                : "No deterministic relationship evidence is available."}
            </p>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
