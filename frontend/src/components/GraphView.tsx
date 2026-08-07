"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

import {
  AdaptedGraphNode,
  VisualizationBundle,
  getConnectedNodeIds,
} from "@/src/utils/graphAdapter";
import { groupColor as paletteColor } from "@/src/utils/palette";
import { useTheme } from "@/src/utils/theme";

type Props = {
  title: string;
  graph: VisualizationBundle["graph"];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
};

/* ─── Simulation types ────────────────────────────────────────────────── */

type SimNode = AdaptedGraphNode & d3.SimulationNodeDatum;
type SimLink = d3.SimulationLinkDatum<SimNode> & { label: string; weight: number };

const SIMPLIFY_THRESHOLD = 100;
const SIM_TICKS = 300;

/* The simulation lives in its own fixed coordinate space; the viewBox tracks
   the stage's pixel size so the drawing is never letterboxed into the middle
   of a wide canvas. The zoom transform maps between the two. */
const WIDTH = 1000;
const HEIGHT = 620;

function radiusFor(node: AdaptedGraphNode): number {
  // Size by outbound fan-out: files that pull in many others are the ones that matter.
  return 11 + Math.sqrt(node.outbound) * 5.5;
}

/* ─── Component ───────────────────────────────────────────────────────── */

export function GraphView({ title, graph, selectedNodeId, onNodeSelect }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const unpinAllRef = useRef<(() => void) | null>(null);

  const [size, setSize] = useState({ w: WIDTH, h: HEIGHT });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(320, Math.round(rect.width));
      const h = Math.max(260, Math.round(rect.height));
      setSize((current) =>
        current.w === w && current.h === h ? current : { w, h },
      );
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [simplified, setSimplified] = useState(
    graph.nodes.length > SIMPLIFY_THRESHOLD,
  );
  const [expanded, setExpanded] = useState(false);

  const theme = useTheme();
  // Held in a ref as well so the layout effect can read the current theme
  // without taking it as a dependency — recolouring must never re-run the
  // simulation, which would scramble positions the user has dragged.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const colorOf = useCallback(
    (group: string) => paletteColor(group, themeRef.current),
    [],
  );

  // Lock page scroll while the graph owns the viewport, and let Esc close it.
  useEffect(() => {
    if (!expanded) return;
    document.body.classList.add("dx-noscroll");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("dx-noscroll");
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

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

    /* One marker per group rather than per colour: the id then stays stable
       across a theme switch, so recolouring never has to rewrite marker-end
       references on every edge. */
    const usedGroups = [...new Set(nodes.map((node) => node.group))];
    const markerId = new Map(usedGroups.map((group, i) => [group, `arrow-${i}`]));
    for (const group of usedGroups) {
      defs
        .append("marker")
        .attr("id", markerId.get(group)!)
        .attr("data-group", group)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-4L9,0L0,4")
        .attr("fill", colorOf(group))
        .attr("opacity", 0.75);
    }

    const root = svg.append("g").attr("class", "gv-root");
    // Layer order = z-index: hulls → group labels → links → nodes
    const hullLayer = root.append("g").attr("class", "gv-hulls");
    const labelLayer = root.append("g").attr("class", "gv-group-labels");
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
          .distance((link) => 105 + (link.source as SimNode).degree * 2.5)
          .strength(0.5),
      )
      .force("charge", d3.forceManyBody<SimNode>().strength((node) => -420 - node.degree * 40))
      .force("center", d3.forceCenter(WIDTH / 2, HEIGHT / 2))
      .force(
        "collide",
        // Clears the label as well as the disc, so text stops colliding.
        d3.forceCollide<SimNode>().radius((node) => radiusFor(node) + 26).iterations(2),
      )
      .force("x", d3.forceX(WIDTH / 2).strength(0.03))
      .force("y", d3.forceY(HEIGHT / 2).strength(0.03))
      // Clustering force: gently pulls same-group nodes toward their group centroid
      // so that convex hulls are tight and readable.
      .force("cluster", (() => {
        let _cn: SimNode[] = [];
        const f = (alpha: number) => {
          const centroids = new Map<string, { x: number; y: number; n: number }>();
          for (const n of _cn) {
            const c = centroids.get(n.group) ?? { x: 0, y: 0, n: 0 };
            c.x += n.x ?? 0; c.y += n.y ?? 0; c.n += 1;
            centroids.set(n.group, c);
          }
          for (const c of centroids.values()) { c.x /= c.n; c.y /= c.n; }
          const k = alpha * 0.12;
          for (const n of _cn) {
            const c = centroids.get(n.group);
            if (!c) continue;
            n.vx = (n.vx ?? 0) - ((n.x ?? 0) - c.x) * k;
            n.vy = (n.vy ?? 0) - ((n.y ?? 0) - c.y) * k;
          }
        };
        return Object.assign(f, { initialize: (ns: SimNode[]) => { _cn = [...ns]; } });
      })())
      .stop();

    // Run to convergence up front, then freeze: no post-load jitter.
    for (let i = 0; i < SIM_TICKS; i += 1) simulation.tick();

    positionsRef.current = new Map(
      nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
    );

    /* ── Convex hull groupings ─────────────────────────────────────────── */
    const HULL_PAD = 22;

    // Sample a ring of points around each node so the hull wraps with padding.
    function hullPoints(gNodes: SimNode[]): [number, number][] | null {
      const pts: [number, number][] = gNodes.flatMap((n) => {
        const cx = n.x ?? 0;
        const cy = n.y ?? 0;
        const r = radiusFor(n) + HULL_PAD;
        return Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
        });
      });
      return d3.polygonHull(pts);
    }

    const byGroup = new Map<string, SimNode[]>();
    for (const n of nodes) {
      const arr = byGroup.get(n.group);
      if (arr) arr.push(n);
      else byGroup.set(n.group, [n]);
    }

    const hullData: Array<{
      group: string;
      path: string;
      cx: number;
      cy: number;
      topY: number;
    }> = [];
    for (const [group, gNodes] of byGroup) {
      const hull = hullPoints(gNodes);
      if (!hull) continue;
      const cx = gNodes.reduce((s, n) => s + (n.x ?? 0), 0) / gNodes.length;
      const cy = gNodes.reduce((s, n) => s + (n.y ?? 0), 0) / gNodes.length;
      const topY = Math.min(...hull.map((p) => p[1]));
      hullData.push({
        group,
        path: `M${hull.map((p) => p.join(",")).join("L")}Z`,
        cx,
        cy,
        topY,
      });
    }

    hullLayer
      .selectAll<SVGPathElement, (typeof hullData)[0]>("path")
      .data(hullData, (d) => d.group)
      .join("path")
      .attr("class", "gv-hull")
      .attr("d", (d) => d.path)
      .attr("fill", (d) => colorOf(d.group))
      .attr("fill-opacity", 0.05)
      .attr("stroke", (d) => colorOf(d.group))
      .attr("stroke-opacity", 0.28)
      .attr("stroke-width", 2)
      .attr("stroke-linejoin", "round")
      .attr("pointer-events", "none");

    labelLayer
      .selectAll<SVGTextElement, (typeof hullData)[0]>("text")
      .data(hullData, (d) => d.group)
      .join("text")
      .attr("class", "gv-group-label")
      .attr("x", (d) => d.cx)
      .attr("y", (d) => d.topY - 7)
      .attr("text-anchor", "middle")
      .attr("fill", (d) => colorOf(d.group))
      .attr("font-size", 15)
      .attr("font-family", "var(--font-mono)")
      .attr("font-weight", "700")
      .attr("letter-spacing", "0.08em")
      .attr("opacity", 1)
      .attr("paint-order", "stroke")
      .attr("stroke", "var(--viz-halo)")
      .attr("stroke-width", 4)
      .attr("stroke-linejoin", "round")
      .attr("pointer-events", "none")
      .text((d) => d.group);

    /* Recompute the hull/label geometry after nodes move (drag, reheat). */
    function refreshHulls() {
      hullData.length = 0;
      for (const [group, gNodes] of byGroup) {
        const hull = hullPoints(gNodes);
        if (!hull) continue;
        const cx = gNodes.reduce((s, n) => s + (n.x ?? 0), 0) / gNodes.length;
        const cy = gNodes.reduce((s, n) => s + (n.y ?? 0), 0) / gNodes.length;
        hullData.push({
          group,
          path: `M${hull.map((p) => p.join(",")).join("L")}Z`,
          cx,
          cy,
          topY: Math.min(...hull.map((p) => p[1])),
        });
      }
      hullLayer
        .selectAll<SVGPathElement, (typeof hullData)[0]>("path")
        .data(hullData, (d) => d.group)
        .attr("d", (d) => d.path);
      labelLayer
        .selectAll<SVGTextElement, (typeof hullData)[0]>("text")
        .data(hullData, (d) => d.group)
        .attr("x", (d) => d.cx)
        .attr("y", (d) => d.topY - 7);
    }


    /* Edges — curved arcs, thickness by endpoint degree */
    linkLayer
      .selectAll<SVGPathElement, SimLink>("path")
      .data(links)
      .join("path")
      .attr("class", "gv-link")
      .attr("data-source", (link) => (link.source as SimNode).id)
      .attr("data-target", (link) => (link.target as SimNode).id)
      .attr("fill", "none")
      .attr("data-group", (link) => (link.source as SimNode).group)
      .attr("stroke", (link) => colorOf((link.source as SimNode).group))
      .attr("stroke-width", (link) =>
        Math.min(5, 1.8 + Math.sqrt((link.target as SimNode).inbound) * 0.8),
      )
      .attr("stroke-opacity", 0.62)
      .attr(
        "marker-end",
        (link) => `url(#${markerId.get((link.source as SimNode).group)})`,
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
      .style("cursor", "grab");

    nodeGroups.append("title").text((node) => `${node.path}\n${node.inbound} in · ${node.outbound} out`);

    // Selection ring (shown via CSS/attr updates in the highlight effect)
    nodeGroups
      .append("circle")
      .attr("class", "gv-ring")
      .attr("r", (node) => radiusFor(node) + 5)
      .attr("fill", "none")
      .attr("stroke", (node) => colorOf(node.group))
      .attr("stroke-width", 1.8)
      .attr("opacity", 0);

    nodeGroups
      .append("circle")
      .attr("class", "gv-dot")
      .attr("r", (node) => radiusFor(node))
      .attr("fill", (node) => colorOf(node.group))
      .attr("fill-opacity", 1)
      .attr("stroke", "var(--viz-halo)")
      .attr("stroke-width", 2);

    nodeGroups
      .append("text")
      .attr("class", "gv-label")
      .attr("y", (node) => radiusFor(node) + 17)
      .attr("text-anchor", "middle")
      .attr("fill", "var(--viz-label)")
      .attr("font-size", 13)
      .attr("font-weight", 500)
      .attr("font-family", "var(--font-mono)")
      .attr("pointer-events", "none")
      // Halo so labels stay legible where they overlap edges or hulls.
      .attr("paint-order", "stroke")
      .attr("stroke", "var(--viz-halo)")
      .attr("stroke-width", 3.5)
      .attr("stroke-linejoin", "round")
      .text((node) => (node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label));

    nodeGroups
      .on("mouseenter", function () {
        d3.select(this).select<SVGCircleElement>(".gv-dot").attr("filter", "url(#node-glow)");
      })
      .on("mouseleave", function () {
        d3.select(this).select<SVGCircleElement>(".gv-dot").attr("filter", null);
      });

    /* ── Live redraw ───────────────────────────────────────────────────
       Positions change during drag, so links/nodes/hulls all reposition
       from one place that both the initial paint and the tick loop call. */
    const linkSel = linkLayer.selectAll<SVGPathElement, SimLink>("path");

    function redraw() {
      linkSel.attr("d", (link) => {
        const s = link.source as SimNode;
        const t = link.target as SimNode;
        const dx = (t.x ?? 0) - (s.x ?? 0);
        const dy = (t.y ?? 0) - (s.y ?? 0);
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.9 || 1;
        return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
      });
      nodeGroups.attr("transform", (node) => `translate(${node.x},${node.y})`);
      refreshHulls();
    }

    simulation.on("tick", redraw);

    /* ── Drag ──────────────────────────────────────────────────────────
       Reheats the simulation so neighbours settle around the dragged node
       instead of the graph looking like a static picture being scrubbed. */
    let dragMoved = false;
    let settleTimer = 0;

    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on("start", function (event, node) {
        dragMoved = false;
        // Keep the canvas pan gesture from starting on the same mousedown.
        event.sourceEvent?.stopPropagation();
        if (!event.active) simulation.alphaTarget(0.22).restart();
        node.fx = node.x;
        node.fy = node.y;
        d3.select(this).classed("dragging", true).style("cursor", "grabbing");
      })
      .on("drag", (event, node) => {
        dragMoved = true;
        node.fx = event.x;
        node.fy = event.y;
        // Paint immediately rather than waiting for the next simulation tick, so the
        // node tracks the cursor 1:1 even while the physics loop is still reheating.
        node.x = event.x;
        node.y = event.y;
        redraw();
      })
      .on("end", function (event, node) {
        if (!event.active) simulation.alphaTarget(0);
        // Stay where dropped. Releasing fx/fy here would let the link, collide and
        // cluster forces drag the node straight back, so the move would look like
        // it never happened. Double-click unpins; Reset clears every pin.
        if (dragMoved) {
          node.fx = node.x;
          node.fy = node.y;
          d3.select(this).classed("pinned", true);
        } else {
          node.fx = null;
          node.fy = null;
        }
        d3.select(this).classed("dragging", false).style("cursor", "grab");
        positionsRef.current.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
        // Let neighbours settle, then park the sim so idle CPU returns to zero.
        settleTimer = window.setTimeout(() => simulation.alpha(0).stop(), 1400);
      });

    nodeGroups.call(drag);

    // Click must not fire after a drag, or dragging would toggle selection.
    nodeGroups.on("click", (event, node) => {
      event.stopPropagation();
      if (dragMoved) return;
      onNodeSelect?.(node.id === selectedNodeId ? null : node.id);
    });

    // Double-click releases a pinned node back to the physics layout.
    nodeGroups.on("dblclick", function (event, node) {
      event.stopPropagation();
      node.fx = null;
      node.fy = null;
      d3.select(this).classed("pinned", false);
      simulation.alpha(0.3).restart();
      settleTimer = window.setTimeout(() => simulation.alpha(0).stop(), 1600);
    });

    // Exposed so the Reset control can unpin everything and re-run the layout.
    unpinAllRef.current = () => {
      for (const node of nodes) {
        node.fx = null;
        node.fy = null;
      }
      nodeGroups.classed("pinned", false);
      simulation.alpha(0.8).restart();
      settleTimer = window.setTimeout(() => simulation.alpha(0).stop(), 2200);
    };

    svg.on("click", () => onNodeSelect?.(null));

    /* Fit the rendered extent into view, against the stage's real size. */
    const xs = nodes.map((node) => node.x ?? 0);
    const ys = nodes.map((node) => node.y ?? 0);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + 60;
    const { w, h } = sizeRef.current;
    const scale = Math.min(
      1.4,
      Math.max(0.2, 0.92 / Math.max((maxX - minX) / w, (maxY - minY) / h)),
    );
    const initial = d3.zoomIdentity
      .translate(w / 2 - ((minX + maxX) / 2) * scale, h / 2 - ((minY + maxY) / 2) * scale)
      .scale(scale);
    svg.call(zoom.transform, initial);

    return () => {
      window.clearTimeout(settleTimer);
      simulation.on("tick", null);
      simulation.stop();
      svg.on(".zoom", null);
    };
    // selectedNodeId intentionally excluded: selection is applied by the effect below
    // so changing it never re-runs the (expensive) layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, onNodeSelect]);

  /* ── Re-fit when the stage resizes ──────────────────────────────────
     Re-running the layout would scramble the settled graph, so this reuses
     the positions already computed and only re-centres the camera. */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current || positionsRef.current.size === 0) return;

    const points = [...positionsRef.current.values()];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + 60;
    const scale = Math.min(
      1.4,
      Math.max(0.2, 0.92 / Math.max((maxX - minX) / size.w, (maxY - minY) / size.h)),
    );

    d3.select(svgEl).call(
      zoomRef.current.transform,
      d3.zoomIdentity
        .translate(
          size.w / 2 - ((minX + maxX) / 2) * scale,
          size.h / 2 - ((minY + maxY) / 2) * scale,
        )
        .scale(scale),
    );
  }, [size]);

  /* ── Recolour on theme change ───────────────────────────────────────
     Halos and label fills ride CSS variables and update on their own; the
     group hues cannot, because they are data-derived. Repaint them in place
     so a theme switch never disturbs the settled layout or pinned nodes. */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);

    svg
      .selectAll<SVGCircleElement, SimNode>(".gv-dot")
      .attr("fill", (node) => paletteColor(node.group, theme));
    svg
      .selectAll<SVGCircleElement, SimNode>(".gv-ring")
      .attr("stroke", (node) => paletteColor(node.group, theme));
    svg
      .selectAll<SVGPathElement, { group: string }>(".gv-hull")
      .attr("fill", (d) => paletteColor(d.group, theme))
      .attr("stroke", (d) => paletteColor(d.group, theme));
    svg
      .selectAll<SVGTextElement, { group: string }>(".gv-group-label")
      .attr("fill", (d) => paletteColor(d.group, theme));
    svg.selectAll<SVGPathElement, unknown>(".gv-link").each(function () {
      const path = d3.select(this);
      const group = path.attr("data-group");
      if (group) path.attr("stroke", paletteColor(group, theme));
    });
    svg.selectAll<SVGMarkerElement, unknown>("marker").each(function () {
      const marker = d3.select(this);
      const group = marker.attr("data-group");
      if (group) marker.select("path").attr("fill", paletteColor(group, theme));
    });
  }, [theme, visible]);

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
    const { w, h } = sizeRef.current;
    d3.select(svgEl)
      .transition()
      .duration(450)
      .call(
        zoomRef.current.transform,
        d3.zoomIdentity
          .translate(w / 2, h / 2)
          .scale(1.5)
          .translate(-position.x, -position.y),
      );
  }, []);

  const resetView = useCallback(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current) return;
    setHiddenGroups(new Set());
    onNodeSelect?.(null);
    // Release every node the user pinned by dragging, and relax the layout.
    unpinAllRef.current?.();
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
    <div className={`gv-panel ${expanded ? "gv-expanded" : ""}`}>
      <div className="gv-controls">
        <div className="gv-controls-left">
          <h3>{title}</h3>
          <span className="gv-inline-stats">
            {visible.nodes.length} nodes · {visible.edges.length} edges
          </span>
          <span className="gv-hint">drag nodes · scroll to zoom · drag canvas to pan</span>
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
          <button
            className="gv-btn wide"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Exit fullscreen (Esc)" : "Expand to fullscreen"}
          >
            {expanded ? "Exit" : "Expand"}
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
              <i style={{ background: colorOf(group) }} />
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

      <div className="gv-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size.w} ${size.h}`}
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
                  style={{ background: colorOf(selectedNode.group) }}
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
                  <strong style={{ color: colorOf(selectedNode.group) }}>
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
                      <i style={{ background: colorOf(neighbor.group) }} />
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
