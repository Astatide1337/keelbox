"use client";
import { useState, useEffect, useRef } from "react";
import { Toast } from "radix-ui";
import { X } from "lucide-react";
import { useAccount } from "./AccountProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
    [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState<string | null>(null),
    popupRef = useRef<Window | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const welcomedProfile = useRef<string | null>(null);
  useEffect(() => {
    setWelcomeOpen(false);
  }, [s?.profile?.key]);
  useEffect(() => {
    if (
      !open &&
      s?.needsWelcome &&
      s.profile &&
      welcomedProfile.current !== s.profile.key
    ) {
      welcomedProfile.current = s.profile.key;
      setWelcomeOpen(true);
    }
  }, [open, s?.needsWelcome, s?.profile?.key]);
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
          if (d.state === "completed") onOpenChange(false);
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
  }, [attempt, account.request, account.refresh, onOpenChange]);
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
              : ""),
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
  if (!s?.enabled) return null;
  return (
    <Toast.Provider duration={8000}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            const trigger = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Open account"]',
            );
            if (trigger) {
              event.preventDefault();
              trigger.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
            <DialogDescription>
              Manage your ChatGPT connection.
            </DialogDescription>
          </DialogHeader>
          {account.error && <p role="alert">{account.error}</p>}
          {
            <>
              <div className="rounded-md border p-4">
                <p className="font-medium">
                  {s.profile?.label.replace(/ · .{6}$/, "") ?? "Not signed in"}
                </p>
                {!s.planEnabled && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {s.profile
                      ? "ChatGPT questions are unavailable for this connection."
                      : "Continue with ChatGPT to connect this installation."}
                  </p>
                )}
              </div>
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
      <Toast.Root
        open={welcomeOpen}
        onOpenChange={(next) => {
          setWelcomeOpen(next);
          if (!next) void operation({ kind: "welcome" });
        }}
        className="flex items-start gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg"
      >
        <Toast.Description className="flex-1">
          You’re using your ChatGPT plan. Subscription eligibility and usage
          limits apply.
        </Toast.Description>
        <Toast.Close asChild>
          <Button variant="ghost" size="icon" aria-label="Dismiss plan notice">
            <X />
          </Button>
        </Toast.Close>
      </Toast.Root>
      <Toast.Viewport className="fixed bottom-4 right-4 z-50 m-0 flex w-[calc(100%-2rem)] max-w-sm list-none flex-col gap-2 outline-none" />
    </Toast.Provider>
  );
}
