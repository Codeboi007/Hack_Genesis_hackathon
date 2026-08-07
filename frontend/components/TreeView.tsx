"use client";

import { useMemo, useState } from "react";

import { GraphPayload } from "@/lib/types";
import { TreeNode, toTreeData } from "@/utils/graphAdapter";

type TreeViewProps = {
  graph?: GraphPayload | null;
  selectedPath?: string | null;
  onNodeSelect?: (filePath: string | null) => void;
};

function TreeBranch({
  node,
  depth,
  expanded,
  toggleExpand,
  selectedPath,
  onNodeSelect,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  selectedPath?: string | null;
  onNodeSelect?: (path: string | null) => void;
}) {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const isExpanded = expanded.has(node.id);
  const isSelected = node.filePath && selectedPath === node.filePath;

  return (
    <div>
      <button
        type="button"
        className={`tree-row ${isSelected ? "active" : ""}`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onClick={() => {
          if (node.type === "folder") {
            toggleExpand(node.id);
            return;
          }
          onNodeSelect?.(node.filePath || null);
        }}
      >
        <span className="tree-caret">
          {hasChildren ? (isExpanded ? "▾" : "▸") : "•"}
        </span>
        <span className="tree-icon">{node.type === "folder" ? "📁" : "📄"}</span>
        <span className="tree-label">{node.name}</span>
      </button>

      {hasChildren && isExpanded && (
        <div>
          {node.children?.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggleExpand={toggleExpand}
              selectedPath={selectedPath}
              onNodeSelect={onNodeSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TreeView({ graph, selectedPath, onNodeSelect }: TreeViewProps) {
  const tree = useMemo(() => toTreeData(graph), [graph]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["root"]));

  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (!tree.children || tree.children.length === 0) {
    return (
      <div className="card empty-state">
        <div className="icon">🌲</div>
        <h3>Tree View</h3>
        <p>No file tree available yet.</p>
      </div>
    );
  }

  return (
    <div className="card tree-view-card">
      <div className="graph-view-header">
        <h3>Tree View</h3>
        <span>{tree.children.length} root items</span>
      </div>
      <div className="tree-scroll">
        {tree.children.map((node) => (
          <TreeBranch
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            toggleExpand={toggleExpand}
            selectedPath={selectedPath}
            onNodeSelect={onNodeSelect}
          />
        ))}
      </div>
    </div>
  );
}
