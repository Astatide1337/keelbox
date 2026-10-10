"use client";
import { memo, useEffect, useState, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  MarkerType,
  type Node,
  type NodeProps,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { Box, Network, File, RotateCcw, Map } from "lucide-react";
import { useTheme } from "@/components/shell/ThemeProvider";
import { Button } from "@/components/ui/button";
import { resourcePresentation } from "@/lib/domain/presentation";
import type { Resource, Relationship, Observation } from "@/lib/domain/types";
import "@xyflow/react/dist/style.css";
type ResourceData = {
  label: string;
  kind: string;
  apiVersion: string;
  detail: string;
  tone: string;
  onSelect: () => void;
};
type ResourceFlowNode = Node<ResourceData, "resource">;
const ResourceNode = memo(function ResourceNode({
  data,
  selected,
}: NodeProps<ResourceFlowNode>) {
  const Icon =
    data.kind === "Service" ? Network : data.kind === "ConfigMap" ? File : Box;
  return (
    <div className={`resource-node ${data.tone} ${selected ? "chosen" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <button onClick={data.onSelect} aria-label={`${data.kind} ${data.label}`}>
        <Icon
          className={`node-icon ${data.kind === "Service" ? "service" : data.kind === "ConfigMap" ? "config" : ""}`}
        />
        <span className="node-content">
          <span className="node-kind">{data.kind}</span>
          <strong>{data.label}</strong>
          <span className="node-version">{data.apiVersion}</span>
          <span className={`node-status ${data.tone}`}>
            <span className="status-dot" />
            {data.detail}
          </span>
        </span>
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
const nodeTypes = { resource: ResourceNode };
export function ResourceGraph({
  resources,
  relationships,
  selected,
  onSelect,
  onRelationship,
  observation,
  stale,
  endpointCoverage,
  provenance,
  initialPositions,
  onPositionsChange,
  initialViewport,
  onViewportChange,
}: {
  resources: Resource[];
  relationships: Relationship[];
  selected: string | null;
  onSelect: (id: string) => void;
  onRelationship: (id: string) => void;
  observation: Observation | null;
  stale: boolean;
  endpointCoverage?: (ns: string | null) => boolean;
  provenance?: string;
  initialPositions?: Record<string, { x: number; y: number }>;
  onPositionsChange?: (p: Record<string, { x: number; y: number }>) => void;
  initialViewport?: Viewport;
  onViewportChange?: (v: Viewport) => void;
}) {
  const { theme } = useTheme();
  const [mapOpen, setMapOpen] = useState(false);
  const [nodes, setNodes] = useState<ResourceFlowNode[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [layoutRevision, setLayoutRevision] = useState(0);
  const flow = useRef<ReactFlowInstance<ResourceFlowNode> | null>(null),
    positionCache = useRef({ ...initialPositions }),
    selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const relayout = useRef(false);
  useEffect(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", ranksep: 65, nodesep: 56 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const r of resources) g.setNode(r.id, { width: 220, height: 114 });
    const valid = relationships.filter(
      (e) =>
        e.to &&
        resources.some((r) => r.id === e.from) &&
        resources.some((r) => r.id === e.to),
    );
    for (const e of valid) g.setEdge(e.from, e.to!);
    dagre.layout(g);
    const force = relayout.current;
    relayout.current = false;
    const next = resources.map((r) => {
      const p = resourcePresentation(
        r,
        observation,
        endpointCoverage?.(r.namespace),
      );
      const position = (!force && positionCache.current[r.id]) || {
        x: g.node(r.id).x - 110,
        y: g.node(r.id).y - 57,
      };
      positionCache.current[r.id] = position;
      return {
        id: r.id,
        type: "resource" as const,
        position,
        selected: selected === r.id,
        data: {
          label: r.name,
          kind: r.kind,
          apiVersion: r.apiVersion,
          detail: p.label,
          tone: p.tone,
          onSelect: () => selectRef.current(r.id),
        },
      };
    });
    setNodes(next);
    onPositionsChange?.(positionCache.current);
    setEdges(
      valid.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to!,
        type: "smoothstep",
        label: e.status === "mismatch" ? "candidate" : e.kind,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: e.status === "mismatch" ? "var(--warning)" : "var(--muted)",
        },
        style: {
          stroke: e.status === "mismatch" ? "var(--warning)" : "var(--muted)",
          strokeWidth: 1.5,
          strokeDasharray:
            e.kind === "references" || e.status !== "match" ? "6 5" : undefined,
        },
        labelStyle: { fill: "var(--foreground)", fontSize: 11 },
        labelBgStyle: { fill: "var(--card)", fillOpacity: 1 },
        labelBgPadding: [8, 5] as [number, number],
        labelBgBorderRadius: 5,
        interactionWidth: 30,
      })),
    );
    if (force)
      requestAnimationFrame(() =>
        flow.current?.fitView({ padding: 0.25, maxZoom: 1 }),
      );
  }, [resources, relationships, observation, layoutRevision]);
  useEffect(
    () =>
      setNodes((n) => n.map((x) => ({ ...x, selected: x.id === selected }))),
    [selected],
  );
  function change(changes: NodeChange<ResourceFlowNode>[]) {
    setNodes((n) => {
      const next = applyNodeChanges(changes, n);
      for (const x of next) positionCache.current[x.id] = x.position;
      onPositionsChange?.(positionCache.current);
      return next;
    });
  }
  return (
    <div className={`graph-canvas ${stale ? "stale" : ""}`}>
      <div className="graph-caption">
        {stale
          ? "Previous graph · source invalid"
          : observation
            ? (provenance ?? "Captured state + inferred relationships")
            : "Relationships inferred from manifests"}
      </div>
      <div className="graph-actions">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            relayout.current = true;
            setLayoutRevision((n) => n + 1);
          }}
        >
          <RotateCcw />
          Relayout
        </Button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={change}
        onNodeClick={(_, n) => onSelect(n.id)}
        onEdgeClick={(_, e) => onRelationship(e.id)}
        onInit={(instance) => {
          flow.current = instance;
        }}
        defaultViewport={initialViewport}
        onMoveEnd={(_, v) => onViewportChange?.(v)}
        fitView={!initialViewport}
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.7}
        nodesConnectable={false}
        deleteKeyCode={null}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{
          "controls.zoomIn.ariaLabel": "Zoom in",
          "controls.zoomOut.ariaLabel": "Zoom out",
          "controls.fitView.ariaLabel": "Fit graph",
        }}
      >
        <Background color="var(--border)" gap={24} />
        <Controls
          showInteractive={false}
          orientation="horizontal"
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        />
        {mapOpen && (
          <MiniMap
            pannable
            zoomable
            nodeColor="var(--muted)"
            maskColor="var(--minimap-mask)"
          />
        )}
      </ReactFlow>
      <div className="graph-map-toggle">
        <Button
          variant="outline"
          size="icon"
          aria-label={mapOpen ? "Hide minimap" : "Show minimap"}
          aria-pressed={mapOpen}
          onClick={() => setMapOpen(!mapOpen)}
        >
          <Map />
        </Button>
      </div>
    </div>
  );
}
