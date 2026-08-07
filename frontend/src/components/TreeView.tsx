"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  TreeNode,
  VisualizationBundle,
  getGroupColor,
  getNodeGroupFromPath,
} from "@/src/utils/graphAdapter";

type Props = {
  tree: TreeNode;
  graph: VisualizationBundle["graph"];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
};

type Degree = { inbound: number; outbound: number };

/* ── Helpers ──────────────────────────────────────────────────────────── */

function collectFolderIds(node: TreeNode, into: Set<string>): Set<string> {
  if (node.type === "folder") {
    into.add(node.id);
    for (const child of node.children) collectFolderIds(child, into);
  }
  return into;
}

function countFiles(node: TreeNode): number {
  return node.type === "file"
    ? 1
    : node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

/* ── Rows ─────────────────────────────────────────────────────────────── */

function FileRow({
  node,
  depth,
  degree,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  degree?: Degree;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const tint = getGroupColor(getNodeGroupFromPath(node.path));
  const links = (degree?.inbound ?? 0) + (degree?.outbound ?? 0);

  return (
    <button
      type="button"
      className={`tv-row tv-file ${selected ? "selected" : ""}`}
      style={{ paddingLeft: 12 + depth * 20 }}
      onClick={() => onSelect(node.id)}
      title={node.path}
    >
      <span className="tv-dot" style={{ background: tint }} />
      <span className="tv-name">{node.name}</span>
      {links > 0 && (
        <span className="tv-deg" title={`${degree?.inbound ?? 0} in · ${degree?.outbound ?? 0} out`}>
          {links}
        </span>
      )}
    </button>
  );
}

function FolderRow({
  node,
  depth,
  open,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`tv-row tv-folder ${open ? "open" : ""}`}
      style={{ paddingLeft: 12 + depth * 20 }}
      onClick={() => onToggle(node.id)}
      aria-expanded={open}
    >
      <span className="tv-caret" aria-hidden>
        ▸
      </span>
      <span className="tv-name">{node.name}</span>
      <span className="tv-count">{countFiles(node)}</span>
    </button>
  );
}

function Branch({
  node,
  depth,
  open,
  degrees,
  selectedNodeId,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  open: Set<string>;
  degrees: Map<string, Degree>;
  selectedNodeId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  if (node.type === "file") {
    return (
      <FileRow
        node={node}
        depth={depth}
        degree={degrees.get(node.id)}
        selected={node.id === selectedNodeId}
        onSelect={onSelect}
      />
    );
  }

  const isOpen = open.has(node.id);

  return (
    <div className="tv-branch">
      <FolderRow node={node} depth={depth} open={isOpen} onToggle={onToggle} />
      {isOpen && (
        <div className="tv-children" style={{ marginLeft: 12 + depth * 20 + 7 }}>
          {node.children.map((child) => (
            <Branch
              key={child.id}
              node={child}
              depth={0}
              open={open}
              degrees={degrees}
              selectedNodeId={selectedNodeId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────────────────── */

export function TreeView({ tree, graph, selectedNodeId, onNodeSelect }: Props) {
  const allFolders = useMemo(
    () => collectFolderIds(tree, new Set<string>()),
    [tree],
  );

  // Fully expanded on generation: the tree should read at a glance, not be a
  // set of closed boxes the user has to open one by one.
  const [open, setOpen] = useState<Set<string>>(allFolders);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setOpen(new Set(allFolders));
  }, [allFolders]);

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

  /** Root-level sections: each top-level folder, plus loose root files. */
  const sections = useMemo(() => {
    const folders = tree.children.filter((c) => c.type === "folder");
    const files = tree.children.filter((c) => c.type === "file");
    const out: Array<{ id: string; label: string; children: TreeNode[]; count: number }> =
      folders.map((f) => ({
        id: f.id,
        label: f.name,
        children: f.children,
        count: countFiles(f),
      }));
    if (files.length > 0) {
      out.unshift({
        id: "root",
        label: "root",
        children: files,
        count: files.length,
      });
    }
    return out;
  }, [tree]);

  /** Filter is applied to the flattened path, so nested matches survive. */
  const matches = useCallback(
    (node: TreeNode): boolean => {
      if (!query.trim()) return true;
      const q = query.trim().toLowerCase();
      if (node.type === "file") return node.path.toLowerCase().includes(q);
      return node.children.some(matches);
    },
    [query],
  );

  const totalFiles = tree.fileCount;
  const visibleSections = sections
    .map((s) => ({ ...s, children: s.children.filter(matches) }))
    .filter((s) => s.children.length > 0);

  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const select = useCallback(
    (id: string) => {
      onNodeSelect?.(id === selectedNodeId ? null : id);
    },
    [onNodeSelect, selectedNodeId],
  );

  return (
    <div className={`tv-panel ${expanded ? "tv-expanded" : ""}`}>
      <div className="tv-head">
        <div className="tv-head-left">
          <h3>File tree</h3>
          <span className="tv-stats">
            {totalFiles} files · {sections.length} top-level
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
          <button className="gv-btn wide" onClick={() => setOpen(new Set(allFolders))}>
            Expand all
          </button>
          <button className="gv-btn wide" onClick={() => setOpen(new Set())}>
            Collapse all
          </button>
          <button
            className="gv-btn wide"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Exit fullscreen (Esc)" : "Fullscreen"}
          >
            {expanded ? "Exit" : "Expand"}
          </button>
        </div>
      </div>

      <div className="tv-body">
        {visibleSections.length === 0 ? (
          <div className="tv-empty">No files match “{query}”.</div>
        ) : (
          <div className="tv-columns">
            {visibleSections.map((section) => (
              <section className="tv-section" key={section.id}>
                <header className="tv-section-head">
                  <span
                    className="tv-section-swatch"
                    style={{ background: getGroupColor(section.label) }}
                  />
                  <span className="tv-section-name">{section.label}</span>
                  <span className="tv-section-count">{section.count}</span>
                </header>
                <div className="tv-section-body">
                  {section.children.map((child) => (
                    <Branch
                      key={child.id}
                      node={child}
                      depth={0}
                      open={open}
                      degrees={degrees}
                      selectedNodeId={selectedNodeId ?? null}
                      onToggle={toggle}
                      onSelect={select}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
