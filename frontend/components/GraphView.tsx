"use client";

import { useMemo } from "react";

import { GraphPayload } from "@/lib/types";
import { toGraphData } from "@/utils/graphAdapter";

type GraphViewProps = {
  graph?: GraphPayload | null;
  selectedPath?: string | null;
  onNodeSelect?: (filePath: string | null) => void;
};

export function GraphView({ graph, selectedPath, onNodeSelect }: GraphViewProps) {
  const mapped = useMemo(() => toGraphData(graph), [graph]);
  const selectedNode = useMemo(
    () => mapped.nodes.find((node) => node.filePath === selectedPath) ?? null,
    [mapped.nodes, selectedPath]
  );

  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of mapped.nodes) counts.set(node.id, 0);
    for (const link of mapped.links) {
      counts.set(link.source, (counts.get(link.source) ?? 0) + 1);
      counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
    }
    return counts;
  }, [mapped.links, mapped.nodes]);

  if (mapped.nodes.length === 0) {
    return (
      <div className="card empty-state">
        <div className="icon">G</div>
        <h3>Graph View</h3>
        <p>No dependency graph data available yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Graph View</h3>
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {mapped.nodes.length} nodes · {mapped.links.length} links
        </span>
      </div>

      <div className="scroll-box" style={{ maxHeight: 460, display: "grid", gap: 8, paddingRight: 4 }}>
        {mapped.nodes.map((node) => {
          const active = selectedNode?.id === node.id;
          return (
            <button
              key={node.id}
              type="button"
              className={`btn ${active ? "btn-primary" : "btn-secondary"}`}
              style={{
                justifyContent: "space-between",
                textAlign: "left",
                padding: "10px 12px",
              }}
              onClick={() => onNodeSelect?.(active ? null : node.filePath)}
            >
              <span style={{ display: "grid", gap: 2 }}>
                <span style={{ fontSize: 12, color: active ? "var(--accent)" : "var(--ink)" }}>{node.label}</span>
                <span style={{ fontSize: 11, color: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>{node.filePath}</span>
              </span>
              <span className="tab-count">{linkCounts.get(node.id) ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
