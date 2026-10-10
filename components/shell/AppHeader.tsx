"use client";
import {
  ChevronDown,
  Clock3,
  Layers3,
  Settings2,
  Upload,
  ChevronsRight,
} from "lucide-react";
import type { RefObject } from "react";
import { useAccount } from "@/components/auth/AccountProvider";
import { useTheme } from "./ThemeProvider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import type { Snapshot } from "@/lib/domain/snapshot";
export function AppHeader({
  source,
  connected,
  onImport,
  onExport,
  onConfigurePractice,
  saveError,
  onAsk,
  onMenu,
  navigationTrigger,
}: {
  source: Snapshot;
  connected: boolean;
  onImport: () => void;
  onExport: () => void;
  onConfigurePractice: () => void;
  saveError?: string;
  onAsk?: () => void;
  onMenu: () => void;
  navigationTrigger: RefObject<HTMLButtonElement | null>;
}) {
  const { theme, setTheme } = useTheme();
  const account = useAccount();
  const origin =
    source.origin === "bundled"
      ? "Bundled example"
      : source.origin === "manifests"
        ? "Manifest project"
        : "Snapshot · not live";
  const date = source.captureEndedAt ? new Date(source.captureEndedAt) : null;
  const capture =
    date && !Number.isNaN(date.valueOf())
      ? date.toLocaleString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
          timeZone: "UTC",
        })
      : null;
  return (
    <header className="topbar">
      <Button
        variant="ghost"
        size="icon"
        className="mobile-menu"
        ref={navigationTrigger}
        aria-label="Open navigation"
        onClick={onMenu}
      >
        <Layers3 />
      </Button>
      <div className="brand">
        <ChevronsRight aria-hidden="true" />
        <strong>Waypoint</strong>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="project-switch">
            <Layers3 />
            <span className="project-label">{source.label}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Selected project</DropdownMenuLabel>
          <DropdownMenuItem disabled>{source.label}</DropdownMenuItem>
          {account.status?.enabled && (
            <DropdownMenuItem onSelect={onAsk}>
              Ask about this project
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onImport}>
            Import manifests or snapshot
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}>Export source</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="header-origin">{origin}</span>
      {capture && (
        <span
          className="header-time"
          title={`${source.captureEndedAt} · capture time, not live`}
        >
          <Clock3 />
          {capture}
        </span>
      )}
      <div className="header-actions">
        {account.status?.enabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={account.open}
            aria-label="Open account"
          >
            {account.status.profile ? "Account" : "Sign in"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="header-import"
          onClick={onImport}
        >
          <Upload />
          Import
        </Button>
        {saveError && (
          <span
            className="text-xs text-muted-foreground"
            title={saveError}
            aria-label={`Progress not saved: ${saveError}`}
          >
            Not saved
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Application settings"
            >
              <Settings2 />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Local application</DropdownMenuLabel>
            <DropdownMenuItem disabled>
              {connected
                ? "Progress saving available"
                : "Progress saving unavailable"}
            </DropdownMenuItem>
            {account.status?.enabled && (
              <DropdownMenuItem onSelect={account.open}>
                {account.status.profile?.label ?? "Sign in with ChatGPT"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onConfigurePractice}>
              Configure practice endpoint
            </DropdownMenuItem>
            {source.errors.length > 0 && (
              <DropdownMenuItem disabled title={source.errors.join("\n")}>
                Capture incomplete
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              Switch to {theme === "dark" ? "light" : "dark"} theme
            </DropdownMenuItem>
            <DropdownMenuLabel>No source-cluster mutations</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
