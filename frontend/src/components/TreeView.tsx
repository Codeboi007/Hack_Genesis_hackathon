"use client";

import {
  Background,
  Controls,
  Edge,
  MarkerType,
  Node,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { useMemo } from "react";

import {
  TreeNode,
  VisualizationBundle,
  getConnectedNodeIds,
  getGroupColor,
  getNodeGroupFromPath,
} from "@/src/utils/graphAdapter";

type Props = {
  tree: TreeNode;
  graph: VisualizationBundle["graph"];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

type Branch = {
  id: string;
  label: string;
  fileCount: number;
  leaves: Array<{
    id: string;
    label: string;
    path: string;
    group: string;
  }>;
};

function toRgb(color: string): string {
  const normalized = color.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const value = Number.parseInt(expanded, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `${red}, ${green}, ${blue}`;
}

function collectFiles(node: TreeNode): Branch["leaves"] {
  if (node.type === "file") {
    return [
      {
        id: node.id,
        label: node.name,
        path: node.path,
        group: getNodeGroupFromPath(node.path),
      },
    ];
  }

  return node.children.flatMap(collectFiles);
}

function buildBranches(tree: TreeNode): Branch[] {
  const rootFiles = tree.children.filter((child) => child.type === "file");
  const rootFolders = tree.children.filter((child) => child.type === "folder");

  const branches: Branch[] = [];

  if (rootFiles.length > 0) {
    branches.push({
      id: "branch:root",
      label: "root",
      fileCount: rootFiles.length,
      leaves: rootFiles.map((file) => ({
        id: file.id,
        label: file.name,
        path: file.path,
        group: getNodeGroupFromPath(file.path),
      })),
    });
  }

  for (const folder of rootFolders) {
    const leaves = collectFiles(folder);
    if (leaves.length === 0) continue;

    branches.push({
      id: `branch:${folder.id}`,
      label: folder.name,
      fileCount: leaves.length,
      leaves,
    });
  }

  return branches;
}

function buildFlow(branches: Branch[], selectedNodeId: string | null, connectedNodeIds: Set<string>) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const hasSelection = Boolean(selectedNodeId);

  const trunkId = "tree-trunk";
  const trunkY =
    branches.length > 0
      ? branches.reduce((sum, _, index) => sum + index * 150 + 110, 0) / branches.length
      : 220;

  nodes.push({
    id: trunkId,
    position: { x: 90, y: trunkY },
    draggable: false,
    selectable: false,
    data: {
      label: <span className="treegraph-trunk" />,
    },
    style: {
      border: "none",
      background: "transparent",
      boxShadow: "none",
      width: 24,
      height: 24,
      padding: 0,
    },
  });

  branches.forEach((branch, branchIndex) => {
    const leafStartY = branchIndex * 150 + 36;
    const leafGap = 40;
    const leafYs = branch.leaves.map((_, leafIndex) => leafStartY + leafIndex * leafGap);
    const branchY =
      leafYs.length > 0
        ? leafYs.reduce((sum, value) => sum + value, 0) / leafYs.length
        : branchIndex * 150 + 110;

    nodes.push({
      id: branch.id,
      position: { x: 500, y: branchY },
      draggable: false,
      selectable: false,
      data: {
        label: (
          <div className="treegraph-branch">
            <span className="treegraph-branch-dot" />
            <span className="treegraph-branch-label">{branch.label}</span>
          </div>
        ),
      },
      style: {
        border: "none",
        background: "transparent",
        boxShadow: "none",
        padding: 0,
      },
    });

    edges.push({
      id: `${trunkId}->${branch.id}`,
      source: trunkId,
      target: branch.id,
      type: "smoothstep",
      animated: false,
      style: {
        stroke: "rgba(71, 85, 105, 0.35)",
        strokeWidth: 1.8,
      },
    });

    branch.leaves.forEach((leaf, leafIndex) => {
      const tint = getGroupColor(leaf.group);
      const active = connectedNodeIds.has(leaf.id);
      const isSelected = selectedNodeId === leaf.id;

      nodes.push({
        id: leaf.id,
        position: { x: 960, y: leafYs[leafIndex] },
        draggable: false,
        selectable: true,
        data: {
          label: (
            <button
              type="button"
              className={`treegraph-leaf ${isSelected ? "selected" : ""}`}
            >
              <span
                className="treegraph-leaf-dot"
                style={{
                  backgroundColor: tint,
                  boxShadow: `0 0 16px rgba(${toRgb(tint)}, 0.45)`,
                }}
              />
              <span className="treegraph-leaf-label">{leaf.label}</span>
            </button>
          ),
        },
        style: {
          border: "none",
          background: "transparent",
          boxShadow: "none",
          padding: 0,
          opacity: hasSelection && !active && !isSelected ? 0.2 : 1,
        },
      });

      edges.push({
        id: `${branch.id}->${leaf.id}`,
        source: branch.id,
        target: leaf.id,
        type: "smoothstep",
        animated: Boolean(selectedNodeId && active),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: active ? "#7dd3fc" : tint,
        },
        style: {
          stroke: active ? "#7dd3fc" : tint,
          strokeWidth: active ? 2.6 : 2.1,
          opacity: hasSelection && !active ? 0.14 : 0.92,
        },
      });
    });
  });

  return { nodes, edges };
}

function TreeCanvas({
  tree,
  graph,
  selectedNodeId,
  onNodeSelect,
  isExpanded = false,
  onToggleExpand,
}: Props) {
  const branches = useMemo(() => buildBranches(tree), [tree]);
  const connectedNodeIds = useMemo(
    () => getConnectedNodeIds(graph, selectedNodeId ?? null),
    [graph, selectedNodeId],
  );
  const flow = useMemo(
    () => buildFlow(branches, selectedNodeId ?? null, connectedNodeIds),
    [branches, connectedNodeIds, selectedNodeId],
  );

  return (
    <div className="viz-panel tree-panel treegraph-panel">
      <div className="viz-panel-header">
        <div>
          <h3>Tree View</h3>
          <p>Dependency tree view with category branches and colored file leaves.</p>
        </div>
        <div className="viz-badge-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm viz-expand-btn"
            onClick={onToggleExpand}
          >
            {isExpanded ? "Exit Expanded View" : "Expand Tree"}
          </button>
          <span className="viz-badge">{branches.length} branches</span>
        </div>
      </div>

      <div className="treegraph-canvas">
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          zoomOnDoubleClick={false}
          minZoom={0.45}
          maxZoom={1.4}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
          onNodeClick={(_, node) => {
            if (node.id.startsWith("branch:") || node.id === "tree-trunk") return;
            onNodeSelect?.(node.id);
          }}
          onPaneClick={() => onNodeSelect?.(null)}
        >
          <Background gap={26} size={1} color="rgba(51, 65, 85, 0.18)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function TreeView(props: Props) {
  return (
    <ReactFlowProvider>
      <TreeCanvas {...props} />
    </ReactFlowProvider>
  );
}
