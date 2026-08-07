"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

import {
  TreeNode,
  VisualizationBundle,
  getNodeGroupFromPath,
} from "@/src/utils/graphAdapter";
import { groupColor as paletteColor } from "@/src/utils/palette";
import { useTheme } from "@/src/utils/theme";

type Props = {
  tree: TreeNode;
  graph: VisualizationBundle["graph"];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
};

type Degree = { inbound: number; outbound: number };

/* ─── Layout constants ────────────────────────────────────────────────── */

/* Vertical pitch between sibling rows and horizontal pitch between depths.
   Generous on purpose: this is a diagram to be read across a canvas, not a
   sidebar list, so leaves get room for their labels. */
const ROW = 30;
const COL = 230;

/* Fallback only. The real viewBox tracks the stage's pixel size — a fixed one
   letterboxes under preserveAspectRatio, leaving wide dead margins on a
   monitor and squeezing the diagram into the middle third. */
const WIDTH = 1200;
const HEIGHT = 680;

type HNode = d3.HierarchyPointNode<TreeNode>;

/* ─── Tree shaping ────────────────────────────────────────────────────── */

/** Keeps only files whose path matches, plus the folders leading to them. */
function pruneTree(node: TreeNode, query: string): TreeNode | null {
  if (node.type === "file") {
    return node.path.toLowerCase().includes(query) ? node : null;
  }
  const kept = node.children
    .map((child) => pruneTree(child, query))
    .filter((child): child is TreeNode => child !== null);
  if (kept.length === 0) return null;
  return { ...node, children: kept };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function collectFolderIds(node: TreeNode, into: Set<string>): Set<string> {
  if (node.type === "folder") {
    into.add(node.id);
    for (const child of node.children) collectFolderIds(child, into);
  }
  return into;
}

/* ─── Component ───────────────────────────────────────────────────────── */

export function TreeView({ tree, graph, selectedNodeId, onNodeSelect }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [size, setSize] = useState({ w: WIDTH, h: HEIGHT });

  /* Track the stage so the viewBox always matches its aspect ratio. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(320, Math.round(rect.width));
      const h = Math.max(260, Math.round(rect.height));
      // Guarded: a fresh object every callback would re-render on every frame
      // of a resize even when the rounded size has not actually changed.
      setSize((current) =>
        current.w === w && current.h === h ? current : { w, h },
      );
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  /* Fullscreen: lock page scroll, Esc to leave. Same contract as the graph. */
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

  const degrees = useMemo(() => {
    const map = new Map<string, Degree>();
    for (const node of graph.nodes) {
      map.set(node.id, { inbound: node.inbound, outbound: node.outbound });
    }
    return map;
  }, [graph.nodes]);

  const allFolders = useMemo(
    () => collectFolderIds(tree, new Set<string>()),
    [tree],
  );

  /** The tree actually drawn, after the filter prunes non-matching branches. */
  const displayTree = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tree;
    return pruneTree(tree, q);
  }, [tree, query]);

  // A new repo means new ids: start fully expanded so the structure reads at
  // a glance rather than as a single closed root.
  useEffect(() => {
    setCollapsed(new Set());
  }, [tree]);

  const toggleFolder = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ── Draw ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    if (!displayTree) return;

    const color = (group: string) => paletteColor(group, themeRef.current);
    const groupOf = (node: TreeNode) =>
      node.path ? getNodeGroupFromPath(node.path) : "root";

    /* Collapsed folders report no children, which is what actually prunes the
       layout — the underlying tree is never mutated. */
    const root = d3.hierarchy<TreeNode>(displayTree, (node) =>
      node.type === "folder" && !collapsed.has(node.id) ? node.children : [],
    );

    const layout = d3
      .tree<TreeNode>()
      .nodeSize([ROW, COL])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.45));

    const laidOut = layout(root) as HNode;
    const nodes = laidOut.descendants() as HNode[];
    const links = laidOut.links() as Array<d3.HierarchyPointLink<TreeNode>>;

    /* Defs: one arrow marker per group, plus a soft glow for hover. */
    const defs = svg.append("defs");
    const usedGroups = [...new Set(nodes.map((n) => groupOf(n.data)))];
    const markerId = new Map(usedGroups.map((g, i) => [g, `tv-arrow-${i}`]));
    for (const group of usedGroups) {
      defs
        .append("marker")
        .attr("id", markerId.get(group)!)
        .attr("data-group", group)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 9)
        .attr("refY", 0)
        .attr("markerWidth", 7)
        .attr("markerHeight", 7)
        .attr("markerUnits", "userSpaceOnUse")
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-4L9,0L0,4")
        .attr("fill", color(group))
        .attr("opacity", 0.85);
    }

    const rootG = svg.append("g").attr("class", "tv-root");
    const linkLayer = rootG.append("g").attr("class", "tv-links");
    const nodeLayer = rootG.append("g").attr("class", "tv-nodes");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.08, 3])
      .on("zoom", (event) => rootG.attr("transform", event.transform.toString()));
    zoomRef.current = zoom;
    svg.call(zoom);
    svg.on("dblclick.zoom", null);

    /* Radii: the root reads largest, then folders, then files. Files also
       carry their dependency degree, so busy files are visibly bigger. */
    const radiusOf = (node: HNode): number => {
      if (node.depth === 0) return 13;
      if (node.data.type === "folder") return 9;
      const degree = degrees.get(node.data.id);
      const links = (degree?.inbound ?? 0) + (degree?.outbound ?? 0);
      return 5 + Math.min(5, Math.sqrt(links) * 1.6);
    };

    /* Links — horizontal beziers, arrow pointing parent → child. Shortened at
       the target end so the arrowhead lands on the rim, not under the disc. */
    const linkPath = (link: d3.HierarchyPointLink<TreeNode>) => {
      const s = link.source as HNode;
      const t = link.target as HNode;
      const pad = radiusOf(t) + 7;
      const tx = t.y - pad;
      const mid = (s.y + tx) / 2;
      return `M${s.y},${s.x}C${mid},${s.x} ${mid},${t.x} ${tx},${t.x}`;
    };

    linkLayer
      .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path")
      .data(links)
      .join("path")
      .attr("class", "tv-link")
      .attr("data-group", (link) => groupOf((link.target as HNode).data))
      .attr("data-target", (link) => (link.target as HNode).data.id)
      .attr("fill", "none")
      .attr("stroke", (link) => color(groupOf((link.target as HNode).data)))
      .attr("stroke-opacity", 0.5)
      .attr("stroke-width", (link) =>
        (link.target as HNode).data.type === "folder" ? 2.2 : 1.4,
      )
      .attr("marker-end", (link) =>
        `url(#${markerId.get(groupOf((link.target as HNode).data))})`,
      )
      .attr("d", linkPath);

    /* Nodes */
    const nodeG = nodeLayer
      .selectAll<SVGGElement, HNode>("g")
      .data(nodes)
      .join("g")
      .attr("class", (node) =>
        `tv-node ${node.data.type === "folder" ? "is-folder" : "is-file"}${
          node.depth === 0 ? " is-root" : ""
        }`,
      )
      .attr("data-id", (node) => node.data.id)
      .attr("transform", (node) => `translate(${node.y},${node.x})`)
      .style("cursor", "pointer");

    nodeG
      .append("title")
      .text((node) =>
        node.data.type === "folder"
          ? `${node.data.path || node.data.name} · ${node.data.fileCount} files`
          : node.data.path,
      );

    // Selection ring, revealed by the highlight effect.
    nodeG
      .append("circle")
      .attr("class", "tv-ring")
      .attr("r", (node) => radiusOf(node) + 5)
      .attr("fill", "none")
      .attr("stroke", (node) => color(groupOf(node.data)))
      .attr("stroke-width", 1.8)
      .attr("opacity", 0);

    nodeG
      .append("circle")
      .attr("class", "tv-disc")
      .attr("r", radiusOf)
      .attr("fill", (node) =>
        // A collapsed folder is drawn hollow, so "there is more inside" is
        // legible from the shape alone rather than only from the caret.
        node.data.type === "folder" && collapsed.has(node.data.id)
          ? "var(--viz-halo)"
          : color(groupOf(node.data)),
      )
      .attr("stroke", (node) => color(groupOf(node.data)))
      .attr("stroke-width", (node) => (node.data.type === "folder" ? 2.6 : 1.6));

    // Count badge inside collapsed folders: the subtree size stays visible.
    nodeG
      .filter((node) => node.data.type === "folder" && collapsed.has(node.data.id))
      .append("text")
      .attr("class", "tv-badge")
      .attr("text-anchor", "middle")
      .attr("dy", "0.34em")
      .attr("font-family", "var(--font-mono)")
      .attr("font-size", 9)
      .attr("font-weight", 700)
      .attr("pointer-events", "none")
      .attr("fill", (node) => color(groupOf(node.data)))
      .text((node) => node.data.fileCount);

    nodeG
      .append("text")
      .attr("class", "tv-text")
      .attr("x", (node) => radiusOf(node) + 9)
      .attr("dy", "0.32em")
      .attr("text-anchor", "start")
      .attr("font-family", "var(--font-mono)")
      .attr("font-size", (node) => (node.data.type === "folder" ? 13.5 : 12.5))
      .attr("font-weight", (node) => (node.data.type === "folder" ? 700 : 400))
      .attr("fill", "var(--viz-label)")
      .attr("paint-order", "stroke")
      .attr("stroke", "var(--viz-halo)")
      .attr("stroke-width", 3.5)
      .attr("stroke-linejoin", "round")
      .attr("pointer-events", "none")
      .text((node) => {
        const name = node.data.name || "/";
        return name.length > 26 ? `${name.slice(0, 25)}…` : name;
      });

    /* Interaction: folders collapse, files select. */
    nodeG.on("click", (event: PointerEvent, node) => {
      event.stopPropagation();
      if (node.data.type === "folder") toggleFolder(node.data.id);
      else onNodeSelect?.(node.data.id === selectedNodeId ? null : node.data.id);
    });

    nodeG
      .on("mouseenter", function () {
        d3.select(this).select(".tv-disc").attr("filter", "url(#tv-glow)");
      })
      .on("mouseleave", function () {
        d3.select(this).select(".tv-disc").attr("filter", null);
      });

    const glow = defs.append("filter").attr("id", "tv-glow");
    glow.attr("x", "-70%").attr("y", "-70%").attr("width", "240%").attr("height", "240%");
    glow.append("feGaussianBlur").attr("stdDeviation", 3.5).attr("result", "b");
    const merge = glow.append("feMerge");
    merge.append("feMergeNode").attr("in", "b");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    svg.on("click", () => onNodeSelect?.(null));

    /* x is the sibling axis (vertical on screen), y is depth (horizontal). */
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const top = Math.min(...xs) - 40;
    const bottom = Math.max(...xs) + 40;
    const left = Math.min(...ys) - 60;
    // Extra right margin: leaf labels extend past their node.
    const right = Math.max(...ys) + 210;

    /* screenY = ty + treeX * scale, so putting tree row `focus` at the middle
       of the stage means ty = h/2 - focus*scale. */
    const transformAt = (scale: number, focus: number) =>
      d3.zoomIdentity
        .translate(size.w / 2 - ((left + right) / 2) * scale, size.h / 2 - focus * scale)
        .scale(scale);

    /* Two different framings, because one cannot serve both needs:

       On arrival, fit the *width*. Every depth level is on screen at a scale
       where the filenames are actually readable, and a tall repo is panned
       vertically — squeezing 60 rows into 400px would reproduce exactly the
       unreadable tangle this view replaced.

       The Fit control then pulls back to the whole tree for an overview. */
    const widthScale = clamp(0.95 / ((right - left) / size.w), 0.45, 1.3);
    const wholeScale = Math.min(
      1.3,
      0.95 / Math.max((right - left) / size.w, (bottom - top) / size.h),
    );

    const middle = (top + bottom) / 2;
    fitRef.current = () => {
      svg.transition().duration(420).call(zoom.transform, transformAt(wholeScale, middle));
    };

    // Centre on the root row, so the repository node and the branches leaving
    // it are what you land on even when the tree is taller than the stage.
    svg.call(zoom.transform, transformAt(widthScale, laidOut.x));

    return () => {
      svg.on(".zoom", null);
    };
    // selectedNodeId drives the highlight effect below, not a redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayTree, collapsed, degrees, toggleFolder, onNodeSelect, size]);

  /* ── Recolour on theme change, without redrawing the layout ─────────── */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const groupOf = (node: TreeNode) =>
      node.path ? getNodeGroupFromPath(node.path) : "root";

    svg.selectAll<SVGCircleElement, HNode>(".tv-disc").attr("fill", (node) =>
      node.data.type === "folder" && collapsed.has(node.data.id)
        ? "var(--viz-halo)"
        : paletteColor(groupOf(node.data), theme),
    );
    svg
      .selectAll<SVGCircleElement, HNode>(".tv-disc, .tv-ring")
      .attr("stroke", (node) => paletteColor(groupOf(node.data), theme));
    svg
      .selectAll<SVGTextElement, HNode>(".tv-badge")
      .attr("fill", (node) => paletteColor(groupOf(node.data), theme));
    svg.selectAll<SVGPathElement, unknown>(".tv-link").each(function () {
      const path = d3.select(this);
      const group = path.attr("data-group");
      if (group) path.attr("stroke", paletteColor(group, theme));
    });
    svg.selectAll<SVGMarkerElement, unknown>("marker").each(function () {
      const marker = d3.select(this);
      const group = marker.attr("data-group");
      if (group) marker.select("path").attr("fill", paletteColor(group, theme));
    });
  }, [theme, displayTree, collapsed]);

  /* ── Selection highlight ────────────────────────────────────────────── */

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const has = Boolean(selectedNodeId);

    svg
      .selectAll<SVGCircleElement, HNode>(".tv-ring")
      .attr("opacity", (node) => (node.data.id === selectedNodeId ? 1 : 0));

    // Dim everything except the selected file's ancestor chain, so the path
    // from the repository root down to the file is the thing you read.
    const chain = new Set<string>();
    if (selectedNodeId) {
      svg.selectAll<SVGGElement, HNode>(".tv-node").each((node) => {
        if (node.data.id === selectedNodeId) {
          let cursor: HNode | null = node;
          while (cursor) {
            chain.add(cursor.data.id);
            cursor = cursor.parent as HNode | null;
          }
        }
      });
    }

    svg
      .selectAll<SVGGElement, HNode>(".tv-node")
      .attr("opacity", (node) => (!has || chain.has(node.data.id) ? 1 : 0.22));

    svg.selectAll<SVGPathElement, unknown>(".tv-link").each(function () {
      const path = d3.select(this);
      const target = path.attr("data-target");
      const active = has && target !== null && chain.has(target);
      path.attr("stroke-opacity", has ? (active ? 0.95 : 0.08) : 0.5);
    });
  }, [selectedNodeId, displayTree, collapsed]);

  /* ── Controls ───────────────────────────────────────────────────────── */

  const zoomBy = useCallback((factor: number) => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current) return;
    d3.select(svgEl).transition().duration(220).call(zoomRef.current.scaleBy, factor);
  }, []);

  const totalFiles = tree.fileCount;
  const visibleFiles = displayTree?.fileCount ?? 0;
  const folderCount = allFolders.size;

  return (
    <div className={`tv-panel ${expanded ? "tv-expanded" : ""}`}>
      <div className="tv-head">
        <div className="tv-head-left">
          <h3>File tree</h3>
          <span className="tv-stats">
            {query.trim() ? `${visibleFiles}/${totalFiles}` : totalFiles} files ·{" "}
            {folderCount} folders
          </span>
          <span className="tv-hint">
            click a folder to fold · scroll to zoom · drag to pan
          </span>
        </div>

        <div className="tv-controls">
          <input
            className="tv-search"
            placeholder="Filter files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter files"
          />
          <button className="gv-btn" onClick={() => zoomBy(1.35)} title="Zoom in">
            +
          </button>
          <button className="gv-btn" onClick={() => zoomBy(1 / 1.35)} title="Zoom out">
            −
          </button>
          <button className="gv-btn wide" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button
            className="gv-btn wide"
            onClick={() => {
              // Keep the root open, or the whole diagram becomes a single dot.
              const next = new Set(allFolders);
              next.delete(tree.id);
              setCollapsed(next);
            }}
          >
            Collapse all
          </button>
          <button
            className="gv-btn wide"
            onClick={() => fitRef.current?.()}
            title="Zoom out to the whole tree"
          >
            Fit all
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

      <div className="tv-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size.w} ${size.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`File tree: ${totalFiles} files across ${folderCount} folders`}
        />
        {!displayTree && (
          <div className="tv-empty">No files match “{query}”.</div>
        )}
      </div>
    </div>
  );
}
