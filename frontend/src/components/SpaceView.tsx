"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

/* ─── 3D primitives ───────────────────────────────────────────────────────
   Hand-rolled rather than pulled from a WebGL engine: the scene is a few
   hundred shaded discs and straight lines, which canvas 2D draws comfortably,
   and it keeps the bundle free of a renderer we would use one screen of. */

type P3 = { x: number; y: number; z: number };

type SpaceNode = AdaptedGraphNode &
  P3 & {
    vx: number;
    vy: number;
    vz: number;
    /** Filled in each frame by the projection pass. */
    sx: number;
    sy: number;
    sr: number;
    depth: number;
  };

const FOCAL = 1100;
/** Pulls the whole cloud in front of the camera so w stays positive. */
const CAMERA_Z = 1250;

function radiusFor(node: AdaptedGraphNode): number {
  return 7.5 + Math.sqrt(node.outbound) * 4.2;
}

/* ─── Layout ──────────────────────────────────────────────────────────────
   A small 3D force pass: groups are seeded onto distinct directions from the
   origin so clusters separate, then repulsion and edge springs settle them.
   Runs once up front and is then frozen — the view rotates a fixed cloud. */

function buildLayout(
  nodes: AdaptedGraphNode[],
  edges: VisualizationBundle["graph"]["edges"],
): SpaceNode[] {
  const groups = [...new Set(nodes.map((n) => n.group))].sort();
  const anchors = new Map<string, P3>();

  // Fibonacci sphere: even angular spacing regardless of how many groups exist.
  const golden = Math.PI * (3 - Math.sqrt(5));
  groups.forEach((group, i) => {
    const y = groups.length === 1 ? 0 : 1 - (i / (groups.length - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const spread = 420;
    anchors.set(group, {
      x: Math.cos(theta) * r * spread,
      y: y * spread,
      z: Math.sin(theta) * r * spread,
    });
  });

  // Deterministic jitter: the same repo always produces the same cloud.
  let seed = 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };

  const out: SpaceNode[] = nodes.map((node) => {
    const anchor = anchors.get(node.group) ?? { x: 0, y: 0, z: 0 };
    return {
      ...node,
      x: anchor.x + rand() * 260,
      y: anchor.y + rand() * 260,
      z: anchor.z + rand() * 260,
      vx: 0,
      vy: 0,
      vz: 0,
      sx: 0,
      sy: 0,
      sr: 0,
      depth: 0,
    };
  });

  const index = new Map(out.map((n, i) => [n.id, i]));
  const springs = edges
    .map((e) => [index.get(e.source), index.get(e.target)] as const)
    .filter((pair): pair is readonly [number, number] =>
      pair[0] !== undefined && pair[1] !== undefined,
    );

  const ITERATIONS = 170;
  const REPULSION = 30000;

  for (let step = 0; step < ITERATIONS; step += 1) {
    const cooling = 1 - step / ITERATIONS;

    // Pairwise repulsion. O(n²), but bounded by the node cap below.
    for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i];
        const b = out[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1) {
          // Coincident nodes have no defined direction; nudge them apart.
          dx = rand();
          dy = rand();
          dz = rand();
          d2 = 1;
        }
        const force = REPULSION / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        const fz = (dz / d) * force;
        a.vx += fx;
        a.vy += fy;
        a.vz += fz;
        b.vx -= fx;
        b.vy -= fy;
        b.vz -= fz;
      }
    }

    // Edge springs.
    for (const [ai, bi] of springs) {
      const a = out[ai];
      const b = out[bi];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const pull = (d - 170) * 0.012;
      const fx = (dx / d) * pull;
      const fy = (dy / d) * pull;
      const fz = (dz / d) * pull;
      a.vx += fx;
      a.vy += fy;
      a.vz += fz;
      b.vx -= fx;
      b.vy -= fy;
      b.vz -= fz;
    }

    // Group cohesion + gentle pull to origin, then integrate with damping.
    for (const node of out) {
      const anchor = anchors.get(node.group);
      if (anchor) {
        node.vx += (anchor.x - node.x) * 0.006;
        node.vy += (anchor.y - node.y) * 0.006;
        node.vz += (anchor.z - node.z) * 0.006;
      }
      node.vx -= node.x * 0.0015;
      node.vy -= node.y * 0.0015;
      node.vz -= node.z * 0.0015;

      const damping = 0.82 * cooling;
      node.x += node.vx * damping * 0.05;
      node.y += node.vy * damping * 0.05;
      node.z += node.vz * damping * 0.05;
      node.vx *= 0.6;
      node.vy *= 0.6;
      node.vz *= 0.6;
    }
  }

  return out;
}

/* ─── Component ───────────────────────────────────────────────────────── */

/** Above this the O(n²) settle pass gets slow, so low-degree files are dropped. */
const NODE_CAP = 320;

export function SpaceView({ title, graph, selectedNodeId, onNodeSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [spinning, setSpinning] = useState(true);

  // Continuous rotation is exactly what a reduced-motion preference is asking
  // us not to do, so it starts paused; the control still turns it on.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSpinning(false);
    }
  }, []);
  const [showEdges, setShowEdges] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const theme = useTheme();

  /* Camera state lives in refs: it changes every frame and must never trigger
     a React render, or the animation loop would fight reconciliation. */
  const yaw = useRef(0.6);
  const pitch = useRef(-0.25);
  const zoom = useRef(1);
  const spinVelocity = useRef(0);
  const needsRender = useRef(true);

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const spinningRef = useRef(spinning);
  spinningRef.current = spinning;
  const showEdgesRef = useRef(showEdges);
  showEdgesRef.current = showEdges;
  const showLabelsRef = useRef(showLabels);
  showLabelsRef.current = showLabels;
  const selectedRef = useRef(selectedNodeId ?? null);
  selectedRef.current = selectedNodeId ?? null;
  const hoverRef = useRef(hoverId);
  hoverRef.current = hoverId;

  useEffect(() => {
    if (!expanded) return;
    document.body.classList.add("dx-noscroll");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("dx-noscroll");
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  const allGroups = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.group))].sort(),
    [graph.nodes],
  );

  /** Nodes in the scene, after the cap and the group filters. */
  const scene = useMemo(() => {
    let nodes = graph.nodes;
    if (nodes.length > NODE_CAP) {
      nodes = [...nodes]
        .sort((a, b) => b.degree - a.degree)
        .slice(0, NODE_CAP);
    }
    if (hiddenGroups.size > 0) {
      nodes = nodes.filter((n) => !hiddenGroups.has(n.group));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    );
    return { nodes, edges };
  }, [graph, hiddenGroups]);

  const positioned = useMemo(
    () => buildLayout(scene.nodes, scene.edges),
    [scene],
  );

  const connected = useMemo(
    () => getConnectedNodeIds(graph, selectedNodeId ?? null),
    [graph, selectedNodeId],
  );
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  const nodesRef = useRef<SpaceNode[]>(positioned);
  nodesRef.current = positioned;
  const edgesRef = useRef(scene.edges);
  edgesRef.current = scene.edges;

  useEffect(() => {
    needsRender.current = true;
  }, [positioned, theme, showEdges, showLabels, selectedNodeId, hoverId, expanded]);

  /* ── Render loop ────────────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let frame = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = stage.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      needsRender.current = true;
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);

    /* Theme colours are read once per theme change, never per frame:
       getComputedStyle forces a style recalculation, and doing that 60 times a
       second was enough to stall the renderer. Same for the id→node map and
       the per-group colours, which only change when the scene does. */
    let palette = { paper: "#ffffff", label: "#1a1a1a", isDark: false };
    let colorCache = new Map<string, string>();
    let byId = new Map<string, SpaceNode>();
    let cacheKey = "";

    const refreshTheme = () => {
      const style = getComputedStyle(document.documentElement);
      const read = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
      palette = {
        paper: read("--viz-canvas", "#ffffff"),
        label: read("--viz-label", "#1a1a1a"),
        isDark: themeRef.current === "dark",
      };
      colorCache = new Map();
    };

    const colorFor = (group: string) => {
      let hit = colorCache.get(group);
      if (!hit) {
        hit = paletteColor(group, themeRef.current);
        colorCache.set(group, hit);
      }
      return hit;
    };

    refreshTheme();
    let lastTheme = themeRef.current;

    const draw = () => {
      const nodes = nodesRef.current;

      if (lastTheme !== themeRef.current) {
        lastTheme = themeRef.current;
        refreshTheme();
      }

      // Rebuild the lookup only when the node set itself changes.
      const key = `${nodes.length}:${nodes[0]?.id ?? ""}:${nodes[nodes.length - 1]?.id ?? ""}`;
      if (key !== cacheKey) {
        cacheKey = key;
        byId = new Map(nodes.map((n) => [n.id, n]));
      }

      const cx = width / 2;
      const cy = height / 2;

      const cosY = Math.cos(yaw.current);
      const sinY = Math.sin(yaw.current);
      const cosP = Math.cos(pitch.current);
      const sinP = Math.sin(pitch.current);
      const z = zoom.current;

      // Project every node once, then reuse for edges, hit-testing and labels.
      for (const node of nodes) {
        const x1 = node.x * cosY - node.z * sinY;
        const z1 = node.x * sinY + node.z * cosY;
        const y2 = node.y * cosP - z1 * sinP;
        const z2 = node.y * sinP + z1 * cosP;

        const w = FOCAL / Math.max(1, FOCAL + z2 + CAMERA_Z);
        node.sx = cx + x1 * w * z;
        node.sy = cy + y2 * w * z;
        node.sr = Math.max(0.6, radiusFor(node) * w * z);
        node.depth = z2;
      }

      const { paper, label, isDark } = palette;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, width, height);

      const selected = selectedRef.current;
      const hovered = hoverRef.current;
      const active = connectedRef.current;
      const hasSelection = Boolean(selected);

      // Painter's algorithm: far to near, so near spheres occlude the ones behind.
      const order = [...nodes].sort((a, b) => b.depth - a.depth);

      if (showEdgesRef.current) {
        ctx.lineWidth = 1;
        for (const edge of edgesRef.current) {
          const a = byId.get(edge.source);
          const b = byId.get(edge.target);
          if (!a || !b) continue;

          const dim =
            hasSelection && !(active.has(a.id) && active.has(b.id)) ? 0.04 : 1;
          // Fade with distance so the far side of the cloud recedes.
          const nearness = 1 - (a.depth + b.depth) / 2 / 1400;
          const alpha = Math.max(0.03, Math.min(0.3, 0.22 * nearness)) * dim;
          if (alpha <= 0.02) continue;

          ctx.strokeStyle = colorFor(a.group);
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      const labelled: SpaceNode[] = [];

      for (const node of order) {
        const color = colorFor(node.group);
        const isSelected = node.id === selected;
        const isHovered = node.id === hovered;
        const dim = hasSelection && !active.has(node.id) ? 0.16 : 1;

        // Distance fog: nearer nodes read fully, far ones sink toward the ground.
        const nearness = Math.max(0.25, Math.min(1, 1 - node.depth / 1500));
        ctx.globalAlpha = nearness * dim;

        // Radial gradient fakes a lit sphere — the flat disc reads as 2D.
        const gradient = ctx.createRadialGradient(
          node.sx - node.sr * 0.35,
          node.sy - node.sr * 0.35,
          node.sr * 0.1,
          node.sx,
          node.sy,
          node.sr,
        );
        gradient.addColorStop(0, mix(color, isDark ? "#ffffff" : "#ffffff", 0.45));
        gradient.addColorStop(0.55, color);
        gradient.addColorStop(1, mix(color, "#000000", isDark ? 0.45 : 0.25));

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(node.sx, node.sy, node.sr, 0, Math.PI * 2);
        ctx.fill();

        if (isSelected || isHovered) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = isSelected ? label : color;
          ctx.lineWidth = isSelected ? 2 : 1.5;
          ctx.beginPath();
          ctx.arc(node.sx, node.sy, node.sr + 5, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Only the nearer, larger spheres get a standing label; the rest would
        // overlap into noise at this density.
        if (isSelected || isHovered || (showLabelsRef.current && node.sr > 5.5)) {
          labelled.push(node);
        }
      }

      ctx.globalAlpha = 1;

      /* Labels last, so nothing is drawn over them. Capped and near-first:
         every node labelled at once is unreadable at this density. */
      const shortlist = labelled
        .sort((a, b) => a.depth - b.depth)
        .slice(0, 42);

      ctx.font = '12px var(--font-mono), ui-monospace, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";

      for (const node of shortlist) {
        const isSelected = node.id === selected;
        const isHovered = node.id === hovered;
        const dim = hasSelection && !active.has(node.id) ? 0.25 : 1;
        ctx.globalAlpha = (isSelected || isHovered ? 1 : 0.85) * dim;

        const text =
          node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label;
        const y = node.sy + node.sr + 11;

        ctx.strokeStyle = paper;
        ctx.lineWidth = 3.5;
        ctx.strokeText(text, node.sx, y);
        ctx.fillStyle = label;
        ctx.fillText(text, node.sx, y);
      }

      ctx.globalAlpha = 1;
    };

    const tick = () => {
      // Idle spin plus any residual flick velocity from a drag.
      if (spinningRef.current) yaw.current += 0.0022;
      if (Math.abs(spinVelocity.current) > 0.00005) {
        yaw.current += spinVelocity.current;
        spinVelocity.current *= 0.94;
        needsRender.current = true;
      }
      if (spinningRef.current || needsRender.current) {
        draw();
        needsRender.current = false;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  /* ── Pointer interaction ────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    /** Distance between the two active touches, for pinch zoom. */
    let pinchStart = 0;
    let pinchZoom = 1;
    const active = new Map<number, { x: number; y: number }>();

    const pick = (clientX: number, clientY: number): SpaceNode | null => {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      let best: SpaceNode | null = null;
      let bestDepth = Infinity;
      for (const node of nodesRef.current) {
        const dx = px - node.sx;
        const dy = py - node.sy;
        const hit = Math.max(node.sr, 7) + 3;
        // Nearest to the camera wins where discs overlap.
        if (dx * dx + dy * dy <= hit * hit && node.depth < bestDepth) {
          best = node;
          bestDepth = node.depth;
        }
      }
      return best;
    };

    const onPointerDown = (event: PointerEvent) => {
      active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        pinchZoom = zoom.current;
        dragging = false;
        return;
      }
      dragging = true;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
      spinVelocity.current = 0;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (active.has(event.pointerId)) {
        active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (active.size === 2) {
        const [a, b] = [...active.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        zoom.current = clamp(pinchZoom * (distance / pinchStart), 0.25, 4);
        needsRender.current = true;
        return;
      }

      if (!dragging) {
        const hit = pick(event.clientX, event.clientY);
        const id = hit?.id ?? null;
        if (id !== hoverRef.current) setHoverId(id);
        canvas.style.cursor = hit ? "pointer" : "grab";
        return;
      }

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      lastX = event.clientX;
      lastY = event.clientY;

      yaw.current += dx * 0.006;
      // Clamped so the cloud can never roll past vertical and invert.
      pitch.current = clamp(pitch.current + dy * 0.006, -1.45, 1.45);
      spinVelocity.current = dx * 0.0012;
      needsRender.current = true;
    };

    const onPointerUp = (event: PointerEvent) => {
      active.delete(event.pointerId);
      if (active.size < 2) pinchStart = 0;
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (moved) return;
      // A tap that never moved is a selection, not the end of an orbit.
      const hit = pick(event.clientX, event.clientY);
      onNodeSelect?.(hit && hit.id !== selectedRef.current ? hit.id : null);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom.current = clamp(zoom.current * (event.deltaY > 0 ? 0.92 : 1.08), 0.25, 4);
      needsRender.current = true;
    };

    const onLeave = () => {
      if (hoverRef.current !== null) setHoverId(null);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [onNodeSelect]);

  /* ── Controls ───────────────────────────────────────────────────────── */

  const reset = useCallback(() => {
    yaw.current = 0.6;
    pitch.current = -0.25;
    zoom.current = 1;
    spinVelocity.current = 0;
    setHiddenGroups(new Set());
    onNodeSelect?.(null);
    needsRender.current = true;
  }, [onNodeSelect]);

  const zoomBy = useCallback((factor: number) => {
    zoom.current = clamp(zoom.current * factor, 0.25, 4);
    needsRender.current = true;
  }, []);

  const toggleGroup = useCallback((group: string) => {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const capped = graph.nodes.length > NODE_CAP;

  return (
    <div className={`vv-panel ${expanded ? "vv-expanded" : ""}`}>
      <div className="vv-head">
        <div className="vv-head-left">
          <h3>{title}</h3>
          <span className="vv-stats">
            {scene.nodes.length} nodes · {scene.edges.length} edges
          </span>
          <span className="vv-hint">drag to orbit · scroll to zoom · tap a node</span>
        </div>

        <div className="vv-controls">
          <button className="gv-btn" onClick={() => zoomBy(1.25)} title="Zoom in">
            +
          </button>
          <button className="gv-btn" onClick={() => zoomBy(1 / 1.25)} title="Zoom out">
            −
          </button>
          <button
            className={`gv-btn wide ${spinning ? "accent" : ""}`}
            onClick={() => setSpinning((v) => !v)}
          >
            {spinning ? "Spinning" : "Paused"}
          </button>
          <button
            className={`gv-btn wide ${showEdges ? "" : "off"}`}
            onClick={() => setShowEdges((v) => !v)}
          >
            Edges
          </button>
          <button
            className={`gv-btn wide ${showLabels ? "" : "off"}`}
            onClick={() => setShowLabels((v) => !v)}
          >
            Labels
          </button>
          <button className="gv-btn wide" onClick={reset}>
            Reset
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
        {allGroups.map((group) => (
          <button
            key={group}
            className={`gv-chip ${hiddenGroups.has(group) ? "off" : ""}`}
            onClick={() => toggleGroup(group)}
          >
            <i style={{ background: paletteColor(group, theme) }} />
            {group}
          </button>
        ))}
      </div>

      {capped && (
        <div className="gv-notice">
          Showing the {NODE_CAP} most connected files — the full graph is
          available in the 2D view.
        </div>
      )}

      <div className="vv-stage" ref={stageRef}>
        <canvas ref={canvasRef} />

        <aside className={`gv-inspector ${selectedNode ? "open" : ""}`}>
          {selectedNode && (
            <>
              <div className="gv-inspector-head">
                <span
                  className="gv-inspector-dot"
                  style={{ background: paletteColor(selectedNode.group, theme) }}
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
                  <strong style={{ color: paletteColor(selectedNode.group, theme) }}>
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
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Blends two #rrggbb colours — used for the sphere highlight and terminator. */
function mix(from: string, to: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const r = Math.round(a[0] + (b[0] - a[0]) * amount);
  const g = Math.round(a[1] + (b[1] - a[1]) * amount);
  const bl = Math.round(a[2] + (b[2] - a[2]) * amount);
  return `rgb(${r},${g},${bl})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean;
  const int = parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}
