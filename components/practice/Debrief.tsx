import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { incidents } from "@/lib/practice/scenarios/catalog";
import type { Exercise } from "@/lib/practice/types";
export function Debrief({ exercise }: { exercise: Exercise }) {
  if (exercise.state !== "completed") return null;
  return (
    <div className="debrief">
      <Accordion type="single" collapsible>
        <AccordionItem value="result">
          <AccordionTrigger>
            Passing the practice scenario · evidence, cause and repair
          </AccordionTrigger>
          <AccordionContent>
            <p>{incidents.find((i) => i.id === exercise.scenario)!.debrief}</p>
            <ul>
              {exercise.checks.map((c) => (
                <li key={c.id}>{c.explanation}</li>
              ))}
            </ul>
            <p>
              <strong>Modeled outcome only.</strong> No live traffic,
              reconciliation or real cluster health was verified.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
