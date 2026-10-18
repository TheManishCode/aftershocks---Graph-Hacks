"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import * as React from "react";
import { memo, useEffect, useMemo, useState } from "react";

import { Viewer } from "@/components/gt";
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

const H: React.CSSProperties[] = [
  { left: -4, top: -4 },
  { right: -4, top: -4 },
  { right: -4, bottom: -4 },
  { left: -4, bottom: -4 },
];

/** A node is a small spec card; the selected one wears the GROUNDTRUTH selection box. */
const Card = memo(function Card({ data }: NodeProps<Node<Data>>) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col justify-center border bg-deep py-2 pr-3 pl-4 transition-colors",
        data.selected ? "border-mark" : data.emphasis ? "border-mark/70" : "border-line-loud hover:border-ink-faint",
      )}
      style={{ width: NODE_W, height: NODE_H }}
      title={data.id}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !rounded-none !border-0 !bg-line-loud" />
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", data.tone ?? "bg-line-loud")} aria-hidden />
      <div className="flex items-center gap-2">
        <span className={cn("truncate font-mono text-[12.5px]", data.selected || data.emphasis ? "text-mark" : "text-ink")}>{symName(data.label)}</span>
        {data.badge && <span className="ml-auto shrink-0 font-mono text-[10px] tracking-[.06em] text-ink-dim uppercase">{data.badge}</span>}
      </div>
      {data.sub && <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">{data.sub}</div>}
      {data.value !== undefined && (
        <div className="mt-1.5 h-[2px] bg-line">
          <div className={cn("h-full", data.tone ?? "bg-ink")} style={{ width: `${Math.max(3, data.value * 100)}%` }} />
        </div>
      )}
      {data.selected && H.map((st, i) => <span key={i} className="absolute size-[7px] border border-mark bg-void" style={st} aria-hidden />)}
      <Handle type="source" position={Position.Right} className="!size-1.5 !rounded-none !border-0 !bg-line-loud" />
    </div>
  );
});

const nodeTypes = { card: Card };

function Inner({ nodes, edges, onSelect, selected, height, direction, hud }: Props) {
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
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#7d8280" },
        style: { stroke: e.dashed ? "#7d8280" : "#a9adab", strokeWidth: e.weight ? 1 + Math.min(2, e.weight) : 1.2, strokeDasharray: e.dashed ? "4 4" : undefined },
        labelStyle: { fill: "#c3c6c4", fontSize: 10, fontFamily: "var(--font-mono)" },
        labelBgStyle: { fill: "#26292b" },
      })),
    [edges],
  );

  return (
    <Viewer className="gt-flow overflow-hidden" style={{ height }} hud={hud} hint={<span>{touch ? "Pinch to zoom · tap a node" : "Drag to pan · scroll to zoom · click a node"}</span>}>
      {rfNodes.length === 0 && nodes.length > 0 && <div className="absolute inset-0 grid place-items-center font-mono text-[11px] tracking-[.12em] text-ink-dim uppercase">Laying out…</div>}
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
        <Background variant={BackgroundVariant.Lines} gap={48} size={1} color="rgba(255,255,255,0.045)" />
        <Controls showInteractive={false} position="bottom-right" className="!mb-9 !mr-5" />
      </ReactFlow>
    </Viewer>
  );
}

interface Props {
  nodes: GNode[];
  edges: GEdge[];
  onSelect?: (id: string) => void;
  selected?: string;
  height?: number | string;
  direction?: "RIGHT" | "LEFT";
  /** top-left readout inside the viewer, chartreuse mono */
  hud?: React.ReactNode;
}

/** A laid-out, pannable graph of cards (elk layered). Used by impact, path, overview subsystems and explore. */
export function GraphCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner height={480} direction="RIGHT" {...props} />
    </ReactFlowProvider>
  );
}
