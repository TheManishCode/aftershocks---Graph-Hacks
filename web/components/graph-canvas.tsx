"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";

import { symName } from "@/lib/format";
import { useMedia } from "@/lib/hooks";
import { layout, NODE_H, NODE_W, type XY } from "@/lib/layout";
import { cn } from "@/lib/utils";

// a type alias, not an interface: xyflow requires node data assignable to Record<string, unknown>
export type GNode = {
  id: string;
  label: string;
  sub?: string;
  /** a tailwind bg-* class for the status bar on the node's left edge */
  tone?: string;
  /** a 0..1 value drawn as a meter under the label (probability, share) */
  value?: number;
  badge?: string;
  group?: string;
  emphasis?: boolean;
};
export interface GEdge {
  src: string;
  dst: string;
  label?: string;
  dashed?: boolean;
  weight?: number;
}

type Data = GNode & { selected?: boolean };

const Card = memo(function Card({ data }: NodeProps<Node<Data>>) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col justify-center overflow-hidden rounded-panel border bg-surface-overlay/95 py-2 pr-3 pl-4 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] transition-colors",
        data.emphasis ? "border-brand/60 shadow-[0_0_0_1px_var(--color-brand),0_0_24px_-6px_var(--color-brand)]" : "border-line hover:border-line-loud",
        data.selected && "border-brand ring-2 ring-brand/50 ring-offset-2 ring-offset-ground",
      )}
      style={{ width: NODE_W, height: NODE_H }}
      title={data.id}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-line-loud" />
      <span className={cn("absolute inset-y-0 left-0 w-1", data.tone ?? "bg-line-loud")} aria-hidden />
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-code text-ink-strong">{symName(data.label)}</span>
        {data.badge && <span className="ml-auto shrink-0 font-mono text-micro text-ink-muted">{data.badge}</span>}
      </div>
      {data.sub && <div className="mt-0.5 truncate font-mono text-micro text-ink-muted">{data.sub}</div>}
      {data.value !== undefined && (
        <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-line">
          <div className={cn("h-full", data.tone ?? "bg-ink")} style={{ width: `${Math.max(3, data.value * 100)}%` }} />
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-line-loud" />
    </div>
  );
});

const nodeTypes = { card: Card };

function Inner({ nodes, edges, onSelect, selected, height, direction }: Props) {
  const [pos, setPos] = useState<Record<string, XY>>({});
  const flow = useReactFlow();
  // on touch screens one finger scrolls the page (the canvas must not trap it); pinch and the buttons zoom and pan
  const touch = useMedia("(pointer: coarse)");
  const key = useMemo(() => nodes.map((n) => n.id).join("|") + "#" + edges.map((e) => e.src + ">" + e.dst).join("|"), [nodes, edges]);

  useEffect(() => {
    let live = true;
    layout({ nodes: nodes.map((n) => ({ id: n.id, group: n.group ?? "" })), edges }, {}, direction)
      .then((p) => {
        if (!live) return;
        setPos(p);
        requestAnimationFrame(() => flow.fitView({ padding: 0.12, maxZoom: 1.1, duration: 250 }));
      })
      .catch(() => live && setPos({}));
    return () => {
      live = false;
    };
    // the key captures every input that changes the layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rfNodes: Node<Data>[] = useMemo(
    () =>
      nodes
        .filter((n) => pos[n.id])
        .map((n) => ({ id: n.id, type: "card", position: pos[n.id], data: { ...n, selected: n.id === selected }, draggable: true, selectable: true })),
    [nodes, pos, selected],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => ({
        id: `${e.src}>${e.dst}#${i}`,
        source: e.src,
        target: e.dst,
        label: e.label,
        type: "smoothstep",
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#6b675c" },
        style: { stroke: e.dashed ? "#6b675c" : "#9d998c", strokeWidth: e.weight ? 1 + Math.min(2, e.weight) : 1.2, strokeDasharray: e.dashed ? "4 4" : undefined },
        labelStyle: { fill: "#9d998c", fontSize: 10, fontFamily: "var(--font-mono)" },
        labelBgStyle: { fill: "#0a0a0a" },
      })),
    [edges],
  );

  return (
    <div className="relative overflow-hidden rounded-panel border border-line bg-ground" style={{ height }}>
      {rfNodes.length === 0 && nodes.length > 0 && <div className="absolute inset-0 grid place-items-center text-body-sm text-ink-muted">Laying out…</div>}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        panOnDrag={!touch}
        preventScrolling={!touch}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2}
        nodesConnectable={false}
        colorMode="dark"
        fitView
      >
        {touch && (
          <Panel position="top-left" className="!m-2 rounded bg-base/90 px-2 py-1 text-micro text-ink-muted">
            Pinch to zoom · tap a node
          </Panel>
        )}
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#26241f" />
        <Controls showInteractive={false} className="!border-line !bg-base [&>button]:!border-line [&>button]:!bg-base [&>button]:!fill-ink-muted" />
      </ReactFlow>
    </div>
  );
}

interface Props {
  nodes: GNode[];
  edges: GEdge[];
  onSelect?: (id: string) => void;
  selected?: string;
  height?: number | string;
  direction?: "RIGHT" | "LEFT";
}

/** A laid-out, pannable graph of cards (elk layered). Used by impact, path, overview subsystems and explore. */
export function GraphCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner height={480} direction="RIGHT" {...props} />
    </ReactFlowProvider>
  );
}
