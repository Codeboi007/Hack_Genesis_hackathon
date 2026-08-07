"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

import {
  AdaptedGraphNode,
  VisualizationBundle,
  getConnectedNodeIds,
} from "@/src/utils/graphAdapter";

type Props = {
  title: string;
  graph: VisualizationBundle["graph"];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
};

/* ─── Group palette ───────────────────────────────────────────────────── */

const GROUP_COLORS: Record<string, string> = {
  backend: "#A7EF9E",
  frontend: "#5ef8d0",
  agents: "#f0c040",
  rag: "#bc8cff",
  docs: "#60a5fa",
  github: "#ff5f5f",
};

const FALLBACK_COLORS = [
  "#7dd3fc",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#fb7185",
  "#f97316",
  "#2dd4bf",
];

function groupColor(group: string): string {
  const known = GROUP_COLORS[group.toLowerCase()];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < group.length; i += 1) {
    hash = (hash * 31 + group.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

/* ─── Simulation types ────────────────────────────────────────────────── */

type SimNode = AdaptedGraphNode & d3.SimulationNodeDatum;
type SimLink = d3.SimulationLinkDatum<SimNode> & { label: string; weight: number };

const SIMPLIFY_THRESHOLD = 100;
const SIM_TICKS = 300;
const WIDTH = 1000;
const HEIGHT = 620;

function radiusFor(node: AdaptedGraphNode): number {
  // Size by outbound fan-out: files that pull in many others are the ones that matter.
  return 7 + Math.sqrt(node.outbound) * 4.5;
}

/* ─── Component ───────────────────────────────────────────────────────── */

export function GraphView({ title, graph, selectedNodeId, onNodeSelect }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [simplified, setSimplified] = useState(
    graph.nodes.length > SIMPLIFY_THRESHOLD,
  );

  const allGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const node of graph.nodes) groups.add(node.group);
    return [...groups].sort();
  }, [graph.nodes]);

  /** Nodes actually rendered, after simplify + group filters. */
  const visible = useMemo(() => {
    let nodes = graph.nodes;
    if (simplified && graph.nodes.length > SIMPLIFY_THRESHOLD) {
      // Isolated leaf files add clutter without telling you anything about structure.
      nodes = nodes.filter((node) => node.degree >= 2);
    }
    if (hiddenGroups.size > 0) {
      nodes = nodes.filter((node) => !hiddenGroups.has(node.group));
    }
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    );
    return { nodes, edges, ids };
  }, [graph, simplified, hiddenGroups]);

  const connected = useMemo(
    () => getConnectedNodeIds(graph, selectedNodeId ?? null),
    [graph, selectedNodeId],
  );

  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  const neighbors = useMemo(() => {
    if (!selectedNodeId) return [] as AdaptedGraphNode[];
    return graph.nodes.filter(
      (node) => node.id !== selectedNodeId && connected.has(node.id),
    );
  }, [graph.nodes, selectedNodeId, connected]);

  const hotspotId = useMemo(() => {
    let best: AdaptedGraphNode | null = null;
    for (const node of visible.nodes) {
      if (!best || node.degree > best.degree) best = node;
    }
    return best?.id ?? null;
  }, [visible.nodes]);

  /* ── Build + run the simulation ────────────────────────────────────── */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    if (visible.nodes.length === 0) return;

    const nodes: SimNode[] = visible.nodes.map((node) => ({ ...node }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: SimLink[] = visible.edges
      .map((edge) => ({
        source: byId.get(edge.source)!,
        target: byId.get(edge.target)!,
        label: edge.label,
        weight: 1,
      }))
      .filter((link) => link.source && link.target);

    /* Defs: glow filter + arrow markers (one per colour used) */
    const defs = svg.append("defs");

    const glow = defs.append("filter").attr("id", "node-glow");
    glow.attr("x", "-70%").attr("y", "-70%").attr("width", "240%").attr("height", "240%");
    glow.append("feGaussianBlur").attr("stdDeviation", 5).attr("result", "blur");
    const glowMerge = glow.append("feMerge");
    glowMerge.append("feMergeNode").attr("in", "blur");
    glowMerge.append("feMergeNode").attr("in", "SourceGraphic");

    const usedColors = [...new Set(nodes.map((node) => groupColor(node.group)))];
    for (const color of usedColors) {
      defs
        .append("marker")
        .attr("id", `arrow-${color.replace("#", "")}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-4L9,0L0,4")
        .attr("fill", color)
        .attr("opacity", 0.75);
    }

    const root = svg.append("g").attr("class", "gv-root");
    const linkLayer = root.append("g").attr("class", "gv-links");
    const nodeLayer = root.append("g").attr("class", "gv-nodes");

    /* Zoom + pan */
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .on("zoom", (event) => root.attr("transform", event.transform.toString()));
    zoomRef.current = zoom;
    svg.call(zoom);
    svg.on("dblclick.zoom", null);

    /* Force layout — auto-arranges, no manual dragging required. */
    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((node) => node.id)
          .distance((link) => 70 + (link.source as SimNode).degree * 2)
          .strength(0.5),
      )
      .force("charge", d3.forceManyBody<SimNode>().strength((node) => -220 - node.degree * 30))
      .force("center", d3.forceCenter(WIDTH / 2, HEIGHT / 2))
      .force(
        "collide",
        d3.forceCollide<SimNode>().radius((node) => radiusFor(node) + 14).iterations(2),
      )
      .force("x", d3.forceX(WIDTH / 2).strength(0.03))
      .force("y", d3.forceY(HEIGHT / 2).strength(0.03))
      .stop();

    // Run to convergence up front, then freeze: no post-load jitter.
    for (let i = 0; i < SIM_TICKS; i += 1) simulation.tick();

    positionsRef.current = new Map(
      nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
    );

    /* Edges — curved arcs, thickness by endpoint degree */
    linkLayer
      .selectAll<SVGPathElement, SimLink>("path")
      .data(links)
      .join("path")
      .attr("class", "gv-link")
      .attr("data-source", (link) => (link.source as SimNode).id)
      .attr("data-target", (link) => (link.target as SimNode).id)
      .attr("fill", "none")
      .attr("stroke", (link) => groupColor((link.source as SimNode).group))
      .attr("stroke-width", (link) =>
        Math.min(3.4, 1 + Math.sqrt((link.target as SimNode).inbound) * 0.5),
      )
      .attr("stroke-opacity", 0.42)
      .attr(
        "marker-end",
        (link) => `url(#arrow-${groupColor((link.source as SimNode).group).replace("#", "")})`,
      )
      .attr("d", (link) => {
        const s = link.source as SimNode;
        const t = link.target as SimNode;
        const dx = (t.x ?? 0) - (s.x ?? 0);
        const dy = (t.y ?? 0) - (s.y ?? 0);
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.9 || 1;
        return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
      });

    /* Nodes */
    const nodeGroups = nodeLayer
      .selectAll<SVGGElement, SimNode>("g")
      .data(nodes)
      .join("g")
      .attr("class", "gv-node")
      .attr("data-id", (node) => node.id)
      .attr("transform", (node) => `translate(${node.x},${node.y})`)
      .style("cursor", "pointer")
      .on("click", (event, node) => {
        event.stopPropagation();
        onNodeSelect?.(node.id === selectedNodeId ? null : node.id);
      });

    nodeGroups.append("title").text((node) => `${node.path}\n${node.inbound} in · ${node.outbound} out`);

    // Selection ring (shown via CSS/attr updates in the highlight effect)
    nodeGroups
      .append("circle")
      .attr("class", "gv-ring")
      .attr("r", (node) => radiusFor(node) + 5)
      .attr("fill", "none")
      .attr("stroke", (node) => groupColor(node.group))
      .attr("stroke-width", 1.8)
      .attr("opacity", 0);

    nodeGroups
      .append("circle")
      .attr("class", "gv-dot")
      .attr("r", (node) => radiusFor(node))
      .attr("fill", (node) => groupColor(node.group))
      .attr("fill-opacity", 0.85)
      .attr("stroke", "#050d05")
      .attr("stroke-width", 1.5);

    nodeGroups
      .append("text")
      .attr("class", "gv-label")
      .attr("y", (node) => radiusFor(node) + 13)
      .attr("text-anchor", "middle")
      .attr("fill", "#d4f0d4")
      .attr("font-size", 10)
      .attr("font-family", "var(--font-mono)")
      .attr("pointer-events", "none")
      .text((node) => (node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label));

    nodeGroups
      .on("mouseenter", function () {
        d3.select(this).select<SVGCircleElement>(".gv-dot").attr("filter", "url(#node-glow)");
      })
      .on("mouseleave", function () {
        d3.select(this).select<SVGCircleElement>(".gv-dot").attr("filter", null);
      });

    svg.on("click", () => onNodeSelect?.(null));

    /* Fit the rendered extent into view */
    const xs = nodes.map((node) => node.x ?? 0);
    const ys = nodes.map((node) => node.y ?? 0);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + 60;
    const scale = Math.min(
      1.4,
      Math.max(0.2, 0.92 / Math.max((maxX - minX) / WIDTH, (maxY - minY) / HEIGHT)),
    );
    const initial = d3.zoomIdentity
      .translate(
        WIDTH / 2 - ((minX + maxX) / 2) * scale,
        HEIGHT / 2 - ((minY + maxY) / 2) * scale,
      )
      .scale(scale);
    svg.call(zoom.transform, initial);

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
    };
    // selectedNodeId intentionally excluded: selection is applied by the effect below
    // so changing it never re-runs the (expensive) layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, onNodeSelect]);

  /* ── Selection highlighting (cheap, no re-layout) ──────────────────── */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const hasSelection = Boolean(selectedNodeId);

    svg
      .selectAll<SVGGElement, SimNode>(".gv-node")
      .attr("opacity", (node) =>
        !hasSelection || connected.has(node.id) ? 1 : 0.2,
      );

    svg
      .selectAll<SVGCircleElement, SimNode>(".gv-ring")
      .attr("opacity", (node) => (node.id === selectedNodeId ? 1 : 0));

    svg
      .selectAll<SVGPathElement, unknown>(".gv-link")
      .each(function () {
        const path = d3.select(this);
        const source = path.attr("data-source");
        const target = path.attr("data-target");
        const active =
          hasSelection && (source === selectedNodeId || target === selectedNodeId);
        path
          .attr("stroke-opacity", hasSelection ? (active ? 0.95 : 0.07) : 0.42)
          .classed("active", active);
      });
  }, [selectedNodeId, connected, visible]);

  /* ── Controls ──────────────────────────────────────────────────────── */

  const zoomBy = useCallback((factor: number) => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current) return;
    d3.select(svgEl).transition().duration(250).call(zoomRef.current.scaleBy, factor);
  }, []);

  const centerOn = useCallback((nodeId: string | null) => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current || !nodeId) return;
    const position = positionsRef.current.get(nodeId);
    if (!position) return;
    d3.select(svgEl)
      .transition()
      .duration(450)
      .call(
        zoomRef.current.transform,
        d3.zoomIdentity
          .translate(WIDTH / 2, HEIGHT / 2)
          .scale(1.5)
          .translate(-position.x, -position.y),
      );
  }, []);

  const resetView = useCallback(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current) return;
    // Re-running the layout effect is the reliable way back to the fitted transform.
    setHiddenGroups(new Set());
    onNodeSelect?.(null);
    d3.select(svgEl)
      .transition()
      .duration(300)
      .call(zoomRef.current.transform, d3.zoomIdentity.translate(0, 0).scale(0.9));
  }, [onNodeSelect]);

  const focusHotspot = useCallback(() => {
    if (!hotspotId) return;
    onNodeSelect?.(hotspotId);
    centerOn(hotspotId);
  }, [hotspotId, onNodeSelect, centerOn]);

  const toggleGroup = useCallback((group: string) => {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const hiddenCount = graph.nodes.length - visible.nodes.length;

  return (
    <div className="gv-panel">
      <div className="gv-controls">
        <div className="gv-controls-left">
          <h3>{title}</h3>
          <span className="gv-inline-stats">
            {visible.nodes.length} nodes · {visible.edges.length} edges
          </span>
        </div>

        <div className="gv-controls-right">
          <button className="gv-btn" onClick={() => zoomBy(1.4)} title="Zoom in">
            +
          </button>
          <button className="gv-btn" onClick={() => zoomBy(1 / 1.4)} title="Zoom out">
            −
          </button>
          <button className="gv-btn wide" onClick={resetView}>
            Reset
          </button>
          <button
            className="gv-btn wide accent"
            onClick={focusHotspot}
            disabled={!hotspotId}
          >
            Focus Hotspot
          </button>
        </div>
      </div>

      <div className="gv-legend">
        {allGroups.map((group) => {
          const hidden = hiddenGroups.has(group);
          return (
            <button
              key={group}
              className={`gv-chip ${hidden ? "off" : ""}`}
              onClick={() => toggleGroup(group)}
              title={hidden ? `Show ${group}` : `Hide ${group}`}
            >
              <i style={{ background: groupColor(group) }} />
              {group}
            </button>
          );
        })}
        {graph.nodes.length > SIMPLIFY_THRESHOLD && (
          <button
            className={`gv-chip toggle ${simplified ? "on" : ""}`}
            onClick={() => setSimplified((v) => !v)}
          >
            {simplified ? "Simplified" : "Show all"}
          </button>
        )}
      </div>

      {simplified && hiddenCount > 0 && (
        <div className="gv-notice">
          Showing {visible.nodes.length}/{graph.nodes.length} nodes — small isolated
          files hidden.
        </div>
      )}

      <div className="gv-stage">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${title}: ${visible.nodes.length} files and ${visible.edges.length} dependencies`}
        />

        {visible.nodes.length === 0 && (
          <div className="gv-empty">
            No nodes to display. Re-enable a group filter to see the graph.
          </div>
        )}

        <aside className={`gv-inspector ${selectedNode ? "open" : ""}`}>
          {selectedNode && (
            <>
              <div className="gv-inspector-head">
                <span
                  className="gv-inspector-dot"
                  style={{ background: groupColor(selectedNode.group) }}
                />
                <strong>{selectedNode.label}</strong>
                <button
                  className="gv-close"
                  onClick={() => onNodeSelect?.(null)}
                  aria-label="Close inspector"
                >
                  ×
                </button>
              </div>

              <code className="gv-inspector-path">{selectedNode.path}</code>

              <div className="gv-inspector-metrics">
                <div>
                  <span>Group</span>
                  <strong style={{ color: groupColor(selectedNode.group) }}>
                    {selectedNode.group}
                  </strong>
                </div>
                <div>
                  <span>Inbound</span>
                  <strong>{selectedNode.inbound}</strong>
                </div>
                <div>
                  <span>Outbound</span>
                  <strong>{selectedNode.outbound}</strong>
                </div>
                <div>
                  <span>Kind</span>
                  <strong>{selectedNode.kind}</strong>
                </div>
              </div>

              <button
                className="gv-btn wide accent gv-jump"
                onClick={() => centerOn(selectedNode.id)}
              >
                Jump to node
              </button>

              <div className="gv-neighbors">
                <span className="gv-inspector-kicker">
                  Neighbors ({neighbors.length})
                </span>
                <div className="gv-neighbor-list">
                  {neighbors.length === 0 && (
                    <span className="gv-neighbor-empty">
                      No connections — this file is isolated.
                    </span>
                  )}
                  {neighbors.slice(0, 20).map((neighbor) => (
                    <button
                      key={neighbor.id}
                      className="gv-neighbor"
                      onClick={() => {
                        onNodeSelect?.(neighbor.id);
                        centerOn(neighbor.id);
                      }}
                    >
                      <i style={{ background: groupColor(neighbor.group) }} />
                      {neighbor.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
