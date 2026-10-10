"use client";
import {
  Network,
  Box,
  List,
  File,
  BookOpen,
  PanelLeftClose,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Resource } from "@/lib/domain/types";
export const destinations = [
  { name: "Topology", icon: Network },
  { name: "Resources", icon: Box },
  { name: "Events", icon: List },
  { name: "Manifest files", icon: File },
  { name: "Practice", icon: BookOpen },
];
export function AppSidebar({
  destination,
  collapsed,
  onCollapse,
  onNavigate,
  resources,
  onSelect,
}: {
  destination: string;
  collapsed: boolean;
  onCollapse: () => void;
  onNavigate: (s: string) => void;
  resources: Resource[];
  onSelect: (id: string) => void;
}) {
  return (
    <aside className={`nav ${collapsed ? "collapsed" : ""}`}>
      <nav aria-label="Project destinations">
        {destinations.map((n) => (
          <Button
            key={n.name}
            variant="ghost"
            className={`nav-item ${destination === n.name ? "current" : ""}`}
            aria-label={n.name}
            aria-current={destination === n.name ? "page" : undefined}
            onClick={() => onNavigate(n.name)}
          >
            <n.icon />
            {!collapsed && n.name}
          </Button>
        ))}
      </nav>
      <div className="nav-bottom">
        <Button
          variant="ghost"
          className="nav-item"
          aria-label="Toggle navigator"
          onClick={onCollapse}
        >
          <PanelLeftClose />
          {!collapsed && "Collapse navigation"}
        </Button>
      </div>
    </aside>
  );
}
