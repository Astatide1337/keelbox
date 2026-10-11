"use client";
import {
  ChevronDown,
  Clock3,
  Layers3,
  Settings2,
  Upload,
  ChevronsRight,
  UserRound,
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
  environment = "source",
  onEnvironment,
  connected,
  onImport,
  onExport,
  onConfigurePractice,
  saveError,
  onAsk,
  onMenu,
  navigationTrigger,
  recentProjects = [],
  onProject,
  labAvailable = true,
}: {
  source: Snapshot;
  environment?: "source" | "lab";
  onEnvironment?: (value: "source" | "lab") => void;
  connected: boolean;
  onImport: () => void;
  onExport: () => void;
  onConfigurePractice: () => void;
  saveError?: string;
  onAsk?: () => void;
  onMenu: () => void;
  navigationTrigger: RefObject<HTMLButtonElement | null>;
  recentProjects?: Snapshot[];
  onProject?: (project: Snapshot) => void;
  labAvailable?: boolean;
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
        <strong className="sr-only sm:not-sr-only">Waypoint</strong>
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
          {recentProjects
            .filter((p) => p.id !== source.id)
            .map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => onProject?.(project)}
              >
                {project.label}
              </DropdownMenuItem>
            ))}
          {account.status?.enabled && (
            <DropdownMenuItem onSelect={onAsk}>
              {environment === "lab" && labAvailable
                ? "Ask about this lab"
                : "Ask about this project"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onImport}>
            Import manifests or snapshot
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}>Export source</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {onEnvironment ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <span className="hidden sm:inline">
                {environment === "lab" ? "Local lab" : origin}
              </span>
              <span className="sm:hidden">
                {environment === "lab" ? "Lab" : "Source"}
              </span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onEnvironment("source")}>
              Imported source
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEnvironment("lab")}>
              Local lab
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="header-origin">{origin}</span>
      )}
      {capture && environment === "source" && (
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
            <UserRound className="sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">
              {account.status.profile ? "Account" : "Sign in"}
            </span>
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
