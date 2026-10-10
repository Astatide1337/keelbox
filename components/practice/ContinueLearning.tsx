"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { incidents } from "@/lib/practice/scenarios/catalog";
import type { InvestigationPage } from "@/lib/practice/history";
export function ContinueLearning({
  connected,
  refreshKey,
  onResume,
  busy,
}: {
  connected: boolean;
  refreshKey: number;
  onResume: (id: string) => void;
  busy: boolean;
}) {
  const [data, setData] = useState<InvestigationPage>({
      items: [],
      issues: [],
    }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        "/api/practice?list=1" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        { cache: "no-store", signal },
      );
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "Checkpoint list unavailable.");
      if (signal?.aborted) return;
      setData((prev) =>
        cursor
          ? {
              ...result,
              items: [...prev.items, ...result.items],
              issues: [...prev.issues, ...result.issues],
            }
          : result,
      );
    } catch (e) {
      if (!signal?.aborted) setError((e as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [connected, refreshKey, load]);
  if (
    !connected ||
    (!loading && !error && !data.items.length && !data.issues.length)
  )
    return null;
  return (
    <section className="continue-learning">
      <h2>Continue learning</h2>
      {!connected ? (
        <p className="muted">
          Local storage is disconnected. Current browser practice remains
          available in memory.
        </p>
      ) : (
        <>
          {error && (
            <div className="notice" role="alert">
              Saved investigations unavailable: {error}{" "}
              <Button variant="outline" size="sm" onClick={() => load()}>
                Retry
              </Button>
            </div>
          )}
          {data.issues.map((issue, i) => (
            <p key={i} className="muted">
              {issue}
            </p>
          ))}
          {loading && !data.items.length ? (
            <p role="status" className="muted">
              Loading saved investigations…
            </p>
          ) : !data.items.length && !error ? (
            <p className="muted">
              {data.issues.length
                ? "No readable checkpoints on this page. Unreadable files remain untouched."
                : "Your investigations will appear here."}
            </p>
          ) : (
            <div className="history-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...data.items]
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          {incidents.find((i) => i.id === item.scenario)?.title}
                          <small
                            className="block mt-1 text-muted-foreground"
                            title={item.updatedAt}
                          >
                            {item.timestampOrigin === "file-modified"
                              ? "Updated"
                              : "Saved"}{" "}
                            {new Date(item.updatedAt).toLocaleString()}
                          </small>
                        </TableCell>
                        <TableCell>{item.projectLabel}</TableCell>
                        <TableCell>
                          {item.state === "completed"
                            ? "Scenario passed"
                            : item.state === "stopped"
                              ? "Stopped"
                              : "Investigation in progress"}{" "}
                          · attempt {item.attempt}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            aria-label={`Resume ${item.projectLabel} ${item.scenario} ${item.id.slice(0, 8)}`}
                            onClick={() => onResume(item.id)}
                          >
                            Resume
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
          {data.nextCursor && (
            <Button
              variant="outline"
              className="mt-4"
              disabled={loading}
              onClick={() => load(data.nextCursor)}
            >
              Load more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
