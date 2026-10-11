"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { Button } from "../ui/button";
import { AccountDialog } from "./AccountDialog";
type Status = {
  enabled: boolean;
  profile: { kind: string; key: string; label: string } | null;
  epoch: string;
  csrf: string;
  planEnabled: boolean;
  needsWelcome: boolean;
  accounts: { id: string; label: string; active: boolean }[];
  issues: string[];
};
type AccountContext = {
  status: Status | null;
  error: string;
  refresh: () => Promise<void>;
  open: () => void;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};
const Context = createContext<AccountContext | null>(null);
export function useAccount() {
  const c = useContext(Context);
  if (!c) throw Error("AccountProvider required.");
  return c;
}
export function AccountProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/auth", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    setStatus(data);
    setError("");
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const url = new URL(location.href),
          connect = url.searchParams.get("connect");
        if (connect) {
          const r = await fetch("/api/session", {
            method: "POST",
            headers: { "X-Playground-Bootstrap": connect },
          });
          if (!r.ok)
            throw Error(
              "Connect link expired. Use the local CLI's one-time connect link.",
            );
          url.searchParams.delete("connect");
          history.replaceState(null, "", url);
        }
        await refresh();
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!ready || !status) return;
    const timer = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [ready, !!status, refresh]);
  const request = useCallback(
    (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (status?.profile) {
        headers.set("X-Waypoint-Profile", status.profile.key);
        headers.set("X-Waypoint-Epoch", status.epoch);
      }
      if (init.method && init.method !== "GET" && status)
        headers.set("X-Playground-Csrf", status.csrf);
      return fetch(path, { ...init, headers });
    },
    [status?.profile?.key, status?.epoch, status?.csrf],
  );
  return (
    <Context.Provider
      value={{ status, error, refresh, open: () => setOpen(true), request }}
    >
      {ready ? (
        <div key={status?.epoch ?? "offline"}>
          {status?.profile ? (
            children
          ) : (
            <main className="flex min-h-screen items-center justify-center p-8">
              <div className="w-full max-w-sm space-y-6">
                <h1 className="text-2xl font-semibold">Waypoint</h1>
                <p className="text-muted-foreground">
                  Explore your Kubernetes applications and practice debugging in
                  your own local cluster.
                </p>
                <Button className="w-full" onClick={() => setOpen(true)}>
                  Sign in with ChatGPT
                </Button>
                {error && (
                  <p role="alert" className="text-sm">
                    {error}
                  </p>
                )}
              </div>
            </main>
          )}
        </div>
      ) : (
        <main className="p-8 text-muted-foreground">
          Connecting local workspace…
        </main>
      )}
      <AccountDialog open={open} onOpenChange={setOpen} />
    </Context.Provider>
  );
}
