"use client";
import type { LearningContext } from "@/lib/practice/live-learning";
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
  retentionKey,
  title,
  disabledReason,
  prepare,
  onEvidence,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  evidenceKey: string;
  retentionKey?: string;
  scope: {
    learning?: LearningContext;
    resourceId?: string;
    relationshipId?: string;
    labId?: string;
    labGeneration?: number;
    labRevision?: number;
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
    (retentionKey ?? evidenceKey) +
    ":" +
    JSON.stringify({
      resourceId: scope.resourceId,
      relationshipId: scope.relationshipId,
      exerciseId: scope.exerciseId,
      labId: scope.labId,
      labGeneration: scope.labGeneration,
    });
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [restoredQuestion, setRestoredQuestion] = useState<{
    key: string;
    value: string;
  } | null>(null);
  useEffect(() => {
    let value = "";
    try {
      value = localStorage.getItem("waypoint:question:v1:" + questionKey) ?? "";
    } catch {}
    setRestoredQuestion({ key: questionKey, value: value.slice(0, 2000) });
  }, [questionKey]);
  const question =
    questions[questionKey] ??
    retainedQuestions.get(questionKey) ??
    (restoredQuestion?.key === questionKey ? restoredQuestion.value : "");
  function setQuestion(value: string) {
    retainedQuestions.set(questionKey, value);
    try {
      localStorage.setItem("waypoint:question:v1:" + questionKey, value);
    } catch {}
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
      context: {
        evidence: Evidence[];
        project?: { live?: boolean; capturedAt?: string | null };
      };
      question: string;
    } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
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
  async function submit() {
    const expectedEvidence = activeEvidence.current;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError("");
    setAnswer("");
    try {
      const projectRevision = await prepare();
      if (pending.signal.aborted || expectedEvidence !== activeEvidence.current)
        return;
      const outgoingId = crypto.randomUUID();
      async function send(kind: "preview" | "ask", digest?: string) {
        const r = await account.request("/api/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            requestId: outgoingId,
            question,
            model,
            projectRevision,
            ...scope,
            digest,
          }),
          signal: pending.signal,
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        return data;
      }
      const outgoing = await send("preview");
      if (pending.signal.aborted || expectedEvidence !== activeEvidence.current)
        return;
      setPreview(outgoing);
      const response = await send("ask", outgoing.digest);
      if (expectedEvidence === activeEvidence.current) setAnswer(response.text);
    } catch (e) {
      if (
        expectedEvidence === activeEvidence.current &&
        (e as Error).name !== "AbortError"
      )
        setError((e as Error).message);
    } finally {
      if (controller.current === pending) setBusy(false);
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
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Ask about your project, understand a resource, or get a practice
            hint.
          </DialogDescription>
        </DialogHeader>
        {!account.status?.planEnabled ? (
          <>
            <p className="text-sm">
              {account.status?.enabled
                ? "Connect an eligible ChatGPT plan to ask questions."
                : "Sign in with ChatGPT to ask questions."}
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
              placeholder="Ask a question or request a hint…"
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
                disabled={busy}
                value={model}
                onValueChange={(v) => {
                  setModel(v);
                  setAnswer("");
                  setPreview(null);
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
            <Button
              disabled={busy || !!disabledReason || !question.trim() || !model}
              onClick={() => void submit()}
            >
              {busy ? "Asking ChatGPT…" : "Send"}
            </Button>
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
                aria-label="ChatGPT reply"
                role="status"
              >
                {renderAnswer()}
              </div>
            )}
          </>
        )}
        <p role="status" aria-live="polite" className="text-sm">
          {error}
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
