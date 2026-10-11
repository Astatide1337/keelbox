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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export function AccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const account = useAccount(),
    s = account.status;
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [model, setModel] = useState("");
  const [attempt, setAttempt] = useState<string | null>(null),
    popupRef = useRef<Window | null>(null);
  useEffect(() => {
    if (!attempt) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const r = await account.request(
          "/api/auth?attempt=" + encodeURIComponent(attempt),
        );
        const d = await r.json();
        if (!r.ok) throw Error(d.error);
        if (!alive) return;
        if (d.state !== "pending") {
          setAttempt(null);
          popupRef.current?.close();
          setMessage(
            d.state === "completed"
              ? "ChatGPT account connected."
              : (d.error ?? "Sign-in cancelled."),
          );
          await account.refresh();
        }
      } catch (e) {
        if (alive) {
          setMessage((e as Error).message);
          setAttempt(null);
        }
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [attempt, account.request, account.refresh]);
  useEffect(() => {
    setModels([]);
    setModel("");
  }, [s?.profile?.key]);
  async function operation(body: unknown) {
    const signingIn =
      !!body &&
      typeof body === "object" &&
      "kind" in body &&
      body.kind === "login";
    const popup = signingIn ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    if (signingIn && !popup) {
      setMessage(
        "Allow the sign-in tab to open, then try again. Your workspace has been retained.",
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const r = await account.request("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      if (
        typeof body === "object" &&
        body &&
        "kind" in body &&
        body.kind === "cancel"
      ) {
        popupRef.current?.close();
        setAttempt(null);
      }
      if (data.url && popup) {
        popupRef.current = popup;
        setAttempt(data.attemptId);
        popup.location.replace(data.url);
        setMessage(
          "Complete consent in the sign-in tab. This workspace and its drafts stay open.",
        );
      } else if (data.url) throw Error("Sign-in tab unavailable.");
      else {
        setMessage(
          data.text ??
            (data.revoked === false
              ? "Signed out locally. Remote revocation could not be confirmed. Manage access in ChatGPT settings."
              : "Done."),
        );
        await account.refresh();
      }
    } catch (e) {
      popup?.close();
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadModels() {
    setBusy(true);
    try {
      const r = await account.request("/api/auth?models=1");
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setModels(data.models);
      setModel(data.models[0]?.id ?? "");
      setMessage(
        data.models.length
          ? "Authorized models loaded."
          : "No authorized models were returned for this registration.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!s?.enabled) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>Manage your ChatGPT connection.</DialogDescription>
        </DialogHeader>
        {account.error && <p role="alert">{account.error}</p>}
        {
          <>
            <div className="rounded-md border p-4">
              <p className="font-medium">
                {s.profile?.label ?? "Not signed in"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {s.planEnabled
                  ? "Using your ChatGPT plan"
                  : s.profile
                    ? "Identity connected; ChatGPT plan inference is unavailable."
                    : "Continue with ChatGPT to connect this installation."}
              </p>
            </div>
            {s.needsWelcome && (
              <div className="rounded-md border p-3 text-sm">
                <p>
                  You’re using your ChatGPT plan. Subscription eligibility and
                  usage limits apply.
                </p>
                <Button
                  variant="outline"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => operation({ kind: "welcome" })}
                >
                  Got it
                </Button>
              </div>
            )}
            {!s.profile && (
              <Button
                disabled={busy}
                onClick={() => operation({ kind: "login" })}
              >
                Continue with ChatGPT
              </Button>
            )}
            {s.profile && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => operation({ kind: "login" })}
              >
                Change account
              </Button>
            )}
            {s.accounts
              .filter((a) => !a.active)
              .map((a) => (
                <Button
                  key={a.id}
                  variant="outline"
                  disabled={busy || a.active}
                  onClick={() => operation({ kind: "login", account: a.id })}
                >
                  {a.active ? "Active: " : "Switch: "}
                  {a.label}
                </Button>
              ))}
            {s.profile && (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => operation({ kind: "signout" })}
                >
                  Sign out
                </Button>
              </>
            )}
            {s.planEnabled && (
              <details>
                <summary className="cursor-pointer text-sm">
                  Connection diagnostics
                </summary>
                <Button variant="outline" disabled={busy} onClick={loadModels}>
                  Load authorized models
                </Button>
                {models.length > 0 && (
                  <>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger aria-label="Inference test model">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      disabled={busy || !model}
                      onClick={() =>
                        operation({ kind: "test-inference", model })
                      }
                    >
                      Test inference · no cluster data
                    </Button>
                  </>
                )}
              </details>
            )}
            <a
              className="text-sm underline"
              href="https://chatgpt.com/settings/usage"
              target="_blank"
              rel="noreferrer"
            >
              Manage usage
            </a>
            {s.issues.map((issue, i) => (
              <p className="text-sm" key={i}>
                {issue}
              </p>
            ))}
          </>
        }
        {attempt && (
          <Button
            variant="outline"
            onClick={() => operation({ kind: "cancel", attemptId: attempt })}
          >
            Cancel sign-in
          </Button>
        )}
        <p role="status" aria-live="polite" className="text-sm break-words">
          {busy ? "Working…" : message}
        </p>
      </DialogContent>
    </Dialog>
  );
}
