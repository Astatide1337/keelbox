"use client";
import { useState, useEffect, useRef } from "react";
import { useAccount } from "./AccountProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
type Evidence = {
  id: string;
  resourceId: string;
  kind: string;
  name?: string;
  source: { line: number };
};
const retainedQuestions = new Map<string, string>();
export function QuestionDialog({
  open,
  onOpenChange,
  scope,
  evidenceKey,
  title,
  disabledReason,
  prepare,
  onEvidence,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  evidenceKey: string;
  scope: {
    resourceId?: string;
    relationshipId?: string;
    exerciseId?: string;
    exerciseRevision?: number;
  };
  title: string;
  disabledReason: string;
  prepare: () => Promise<string | undefined>;
  onEvidence: (id: string) => void;
}) {
  const account = useAccount();
  const questionKey =
    (account.status?.profile?.key ?? "development") +
    ":" +
    JSON.stringify({
      resourceId: scope.resourceId,
      relationshipId: scope.relationshipId,
      exerciseId: scope.exerciseId,
    });
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const question =
    questions[questionKey] ?? retainedQuestions.get(questionKey) ?? "";
  function setQuestion(value: string) {
    retainedQuestions.set(questionKey, value);
    if (retainedQuestions.size > 100)
      retainedQuestions.delete(retainedQuestions.keys().next().value!);
    setQuestions((previous) => ({ ...previous, [questionKey]: value }));
  }
  const [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [answer, setAnswer] = useState(""),
    [preview, setPreview] = useState<{
      digest: string;
      context: { evidence: Evidence[] };
      question: string;
    } | null>(null);
  const revision = useRef<string | undefined>(undefined),
    requestId = useRef("");
  const controller = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify(scope);
  const activeEvidence = useRef("");
  activeEvidence.current = JSON.stringify([
    scopeKey,
    evidenceKey,
    open,
    disabledReason,
  ]);
  useEffect(() => {
    controller.current?.abort();
    setPreview(null);
    setAnswer("");
    setError("");
    return () => controller.current?.abort();
  }, [scopeKey, evidenceKey, open, disabledReason]);
  useEffect(() => {
    if (!open || !account.status?.planEnabled) return;
    let alive = true;
    account
      .request("/api/auth?models=1")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error);
        if (alive) {
          setModels(d.models);
          setModel(d.models[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [open, account.request, account.status?.planEnabled]);
  async function submit(kind: "preview" | "ask") {
    const expectedEvidence = activeEvidence.current;
    setBusy(true);
    setError("");
    controller.current = new AbortController();
    try {
      if (kind === "preview") {
        revision.current = await prepare();
        requestId.current = crypto.randomUUID();
      }
      const r = await account.request("/api/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          requestId: requestId.current,
          question,
          model,
          projectRevision: revision.current,
          ...scope,
          digest: kind === "ask" ? preview?.digest : undefined,
        }),
        signal: controller.current.signal,
      });
      const data = await r.json();
      if (expectedEvidence !== activeEvidence.current) return;
      if (!r.ok) throw Error(data.error);
      if (kind === "preview") setPreview(data);
      else setAnswer(data.text);
    } catch (e) {
      if (
        expectedEvidence === activeEvidence.current &&
        (e as Error).name !== "AbortError"
      )
        setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function renderAnswer() {
    return answer.split(/(\[E\d+\]|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
      const id = part.slice(1, -1),
        e = preview?.context.evidence.find((e) => e.id === id);
      return e ? (
        <Button
          key={i}
          variant="link"
          className="h-auto px-1"
          onClick={() => {
            onEvidence(e.resourceId);
            onOpenChange(false);
          }}
          aria-label={`Open ${e.kind} ${e.name} evidence`}
        >
          {part}
        </Button>
      ) : part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <span key={i}>{part}</span>
      );
    });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Ask a question about this project or resource.
          </DialogDescription>
        </DialogHeader>
        {!account.status?.planEnabled ? (
          <>
            <p className="text-sm">
              {account.status?.enabled
                ? "Connect an eligible ChatGPT plan to ask questions."
                : "AI is disabled in no-login development mode."}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                account.open();
              }}
            >
              Open account
            </Button>
          </>
        ) : (
          <>
            <Textarea
              aria-label="Question about Kubernetes evidence"
              placeholder="What does this resource do, and what evidence should I inspect?"
              value={question}
              maxLength={2000}
              onChange={(e) => {
                setQuestion(e.target.value);
                setPreview(null);
                setAnswer("");
              }}
              disabled={busy}
            />
            <details>
              <summary className="cursor-pointer text-sm">
                Model settings
              </summary>
              <Select
                value={model}
                onValueChange={(v) => {
                  setModel(v);
                  requestId.current = crypto.randomUUID();
                  setAnswer("");
                }}
              >
                <SelectTrigger aria-label="Question model">
                  <SelectValue placeholder="Authorized model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem value={m.id} key={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </details>
            {disabledReason && (
              <p role="status" className="text-sm">
                {disabledReason}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Your question and selected evidence are sent to OpenAI using your
              ChatGPT plan. Review before sending; names and paths may be
              sensitive.
            </p>
            <Button
              variant="outline"
              disabled={busy || !!disabledReason || !question.trim() || !model}
              onClick={() => submit("preview")}
            >
              Review request
            </Button>
            {preview && (
              <>
                <p className="text-sm">
                  This request includes your question and filtered project
                  evidence. Secret data, configuration values, environment
                  values, annotations, raw events and logs are excluded.
                </p>
                <details
                  key={answer ? "answered" : "preview"}
                  className="rounded-md border p-3"
                >
                  <summary className="cursor-pointer text-sm">
                    Technical details
                  </summary>
                  <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(
                      { model, question: preview.question, ...preview.context },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <Button disabled={busy} onClick={() => submit("ask")}>
                  Send question
                </Button>
              </>
            )}
            {busy && (
              <Button
                variant="outline"
                onClick={() => controller.current?.abort()}
              >
                Cancel request
              </Button>
            )}
            {answer && (
              <div
                className="rounded-md border p-4 whitespace-pre-wrap text-sm"
                aria-label="AI explanation"
              >
                {renderAnswer()}
              </div>
            )}
          </>
        )}
        <p role="status" aria-live="polite" className="text-sm">
          {busy ? "Working…" : error}
        </p>
        <a
          className="text-sm underline"
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
        >
          Manage usage
        </a>
      </DialogContent>
    </Dialog>
  );
}
