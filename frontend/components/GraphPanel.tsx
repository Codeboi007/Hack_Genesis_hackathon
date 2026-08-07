"use client";

import { GraphPayload, GraphNode } from "@/lib/types";
import { useMemo } from "react";

/* ─── Types ────────────────────────────────────────────── */
type Props = { title: string; graph?: GraphPayload | null };

type PositionedNode = GraphNode & { x: number; y: number };

/* ─── Node type colour map ─────────────────────────────── */
const KIND_COLOR: Record<string, string> = {
  module:     "#58a6ff",
  function:   "#3fb950",
  class:      "#bc8cff",
  dependency: "#d29922",
  file:       "#79c0ff",
  default:    "#8b949e",
};

function nodeColor(kind: string) {
  return KIND_COLOR[kind.toLowerCase()] ?? KIND_COLOR.default;
}

/* ─── Simple force-ish layout (deterministic) ──────────── */
function layoutNodes(nodes: GraphNode[], width: number, height: number): PositionedNode[] {
  const n = nodes.length;
  if (n === 0) return [];

  // Spiral / golden-angle layout for clean spread
  const cx = width / 2;
  const cy = height / 2;
  const golden = Math.PI * (3 - Math.sqrt(5));

  return nodes.map((node, i) => {
    const r = Math.sqrt((i + 0.5) / n) * Math.min(cx, cy) * 0.85;
    const theta = i * golden;
    return {
      ...node,
      x: cx + r * Math.cos(theta),
      y: cy + r * Math.sin(theta),
    };
  });
}

/* ─── GraphPanel ───────────────────────────────────────── */
export function GraphPanel({ title, graph }: Props) {
  const MAX_NODES = 30;
  const MAX_EDGES = 45;

  const safeGraph: GraphPayload = {
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
  };

  const nodes  = safeGraph.nodes.slice(0, MAX_NODES);
  const edges  = safeGraph.edges.slice(0, MAX_EDGES);
  const width  = 760;
  const height = 380;

  const positioned = useMemo(() => layoutNodes(nodes, width, height), [nodes]);
  const posMap = useMemo(() => {
    const m: Record<string, PositionedNode> = {};
    for (const n of positioned) m[n.id] = n;
    return m;
  }, [positioned]);

  // Derive legend from actual node kinds
  const kinds = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) s.add(n.kind?.toLowerCase() || "default");
    return [...s];
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="card empty-state" style={{ padding: 30 }}>
        <div className="icon">🕸️</div>
        <p>No graph data available.</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {nodes.length} nodes · {edges.length} edges
        </span>
      </div>

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{
          background: "var(--bg-3)",
          borderRadius: 10,
          border: "1px solid var(--border)",
          width: "100%",
          display: "block",
        }}
      >
        <defs>
          <marker
            id={`arrow-${title.replace(/\s/g, "")}`}
            markerWidth="8"
            markerHeight="8"
            refX="8"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L8,3 z" fill="#30363d" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge, idx) => {
          const src = posMap[edge.source];
          const tgt = posMap[edge.target];
          if (!src || !tgt) return null;

          // Offset line ends by node radius to avoid overlap
          const r = 16;
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = src.x + (dx / dist) * r;
          const y1 = src.y + (dy / dist) * r;
          const x2 = tgt.x - (dx / dist) * (r + 8);
          const y2 = tgt.y - (dy / dist) * (r + 8);
          return (
            <line
              key={`e-${idx}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="#30363d"
              strokeWidth={1.5}
              markerEnd={`url(#arrow-${title.replace(/\s/g, "")})`}
            />
          );
        })}

        {/* Nodes */}
        {positioned.map((node) => {
          const color = nodeColor(node.kind);
          const label = node.label.length > 18 ? node.label.slice(0, 16) + "…" : node.label;

          return (
            <g key={node.id}>
              {/* Glow ring */}
              <circle
                cx={node.x} cy={node.y}
                r={20}
                fill={color}
                opacity={0.08}
              />
              {/* Main node */}
              <circle
                cx={node.x} cy={node.y}
                r={15}
                fill={color}
                fillOpacity={0.9}
                stroke="#0d1117"
                strokeWidth={1.5}
              />
              {/* Label */}
              <text
                x={node.x}
                y={node.y + 30}
                textAnchor="middle"
                fontSize={10}
                fontFamily="inherit"
                fill="#8b949e"
                fontWeight={500}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="legend">
        {kinds.map((kind) => (
          <span key={kind} className="legend-item">
            <span className="legend-dot" style={{ background: nodeColor(kind) }} />
            {kind}
          </span>
        ))}
        {(safeGraph.nodes.length > MAX_NODES || safeGraph.edges.length > MAX_EDGES) && (
          <span style={{ marginLeft: "auto", fontStyle: "italic" }}>
            Showing sampled view — {safeGraph.nodes.length} total nodes
          </span>
        )}
      </div>
    </div>
  );
}
