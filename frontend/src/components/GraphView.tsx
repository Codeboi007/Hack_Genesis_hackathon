"use client";

import {
  Background,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import {
  AdaptedGraphNode,
  VisualizationBundle,
  getGroupColor,
  getConnectedNodeIds,
} from "@/src/utils/graphAdapter";

type Props = {
  title: string;
  graph: VisualizationBundle["graph"];
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

const NODE_COLORS: Record<string, string> = {
  component: "#7dd3fc",
  module: "#60a5fa",
  service: "#34d399",
  file: "#fbbf24",
};

function nodeColor(kind: string): string {
  return NODE_COLORS[kind] ?? "#94a3b8";
}

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

function layoutNodes(nodes: AdaptedGraphNode[]): Node[] {
  const groups = new Map<string, AdaptedGraphNode[]>();

  for (const node of nodes) {
    const bucket = groups.get(node.group) ?? [];
    bucket.push(node);
    groups.set(node.group, bucket);
  }

  const orderedGroups = [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return orderedGroups.flatMap(([groupName, groupNodes], groupIndex) =>
    groupNodes
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node, nodeIndex) => {
        const kindTint = nodeColor(node.kind);
        const groupTint = getGroupColor(node.group);

        return {
          id: node.id,
          type: "default",
          draggable: true,
          position: {
            x: groupIndex * 260 + (node.depth % 2) * 24,
            y: nodeIndex * 110 + (groupName.length % 3) * 20,
          },
          data: {
            tint: groupTint,
            label: (
              <div className="flow-node-card">
                <div className="flow-node-top">
                  <span
                    className="flow-node-dot"
                    style={{ backgroundColor: groupTint }}
                  />
                  <span className="flow-node-kind">{node.kind}</span>
                </div>
                <strong>{node.label}</strong>
                <span>{node.path}</span>
                <span
                  className="flow-node-group"
                  style={{ color: groupTint }}
                >
                  {node.group}
                </span>
              </div>
            ),
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          style: {
            width: 210,
            borderRadius: 14,
            border: `1px solid rgba(${toRgb(groupTint)}, 0.42)`,
            background:
              "linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.88))",
            color: "#e2e8f0",
            boxShadow: `0 16px 40px rgba(2, 6, 23, 0.32), inset 0 0 0 1px rgba(${toRgb(kindTint)}, 0.12)`,
          },
        };
      }),
  );
}

function buildEdges(graph: VisualizationBundle["graph"]): Edge[] {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));

  return graph.edges.map((edge) => {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    const edgeTint = getGroupColor(
      sourceNode?.group ?? targetNode?.group ?? "root",
    );
    return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    animated: false,
    label: edge.label || undefined,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 18,
      height: 18,
      color: edgeTint,
    },
    style: {
      stroke: edgeTint,
      strokeWidth: 2.2,
    },
    labelStyle: {
      fill: edgeTint,
      fontSize: 11,
    },
    };
  });
}

function GraphCanvas({
  title,
  graph,
  selectedNodeId,
  onNodeSelect,
  isExpanded = false,
  onToggleExpand,
}: Props) {
  const baseNodes = useMemo(() => layoutNodes(graph.nodes), [graph.nodes]);
  const baseEdges = useMemo(() => buildEdges(graph), [graph]);

  const [nodes, setNodes, onNodesChange] = useNodesState(baseNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(baseEdges);

  useEffect(() => {
    setNodes(baseNodes);
  }, [baseNodes, setNodes]);

  useEffect(() => {
    setEdges(baseEdges);
  }, [baseEdges, setEdges]);

  useEffect(() => {
    const connected = getConnectedNodeIds(graph, selectedNodeId ?? null);
    const hasSelection = Boolean(selectedNodeId);

    setNodes((current) =>
      current.map((node) => {
        const active = connected.has(node.id);
        return {
          ...node,
          style: {
            ...node.style,
            opacity: hasSelection && !active ? 0.22 : 1,
            borderColor:
              node.id === selectedNodeId
                ? "rgba(125, 211, 252, 0.95)"
                : active
                  ? `rgba(${toRgb(String(node.data?.tint ?? "#60a5fa"))}, 0.55)`
                  : "rgba(148, 163, 184, 0.2)",
            boxShadow:
              node.id === selectedNodeId
                ? "0 0 0 1px rgba(125, 211, 252, 0.95), 0 20px 45px rgba(14, 165, 233, 0.18)"
                : "0 16px 40px rgba(2, 6, 23, 0.32)",
          },
        };
      }),
    );

    setEdges((current) =>
      current.map((edge) => {
        const active =
          edge.source === selectedNodeId ||
          edge.target === selectedNodeId ||
          (!hasSelection && true);

        return {
          ...edge,
          animated: Boolean(selectedNodeId && active),
          style: {
            ...edge.style,
            opacity: hasSelection && !active ? 0.14 : 0.95,
            stroke: active
              ? "#7dd3fc"
              : edge.style?.stroke,
          },
        };
      }),
    );
  }, [graph, selectedNodeId, setEdges, setNodes]);

  return (
    <div className="viz-panel graph-panel">
      <div className="viz-panel-header">
        <div>
          <h3>{title}</h3>
          <p>Drag nodes, pan the canvas, and click a file to trace its neighbors.</p>
        </div>
        <div className="viz-badge-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm viz-expand-btn"
            onClick={onToggleExpand}
          >
            {isExpanded ? "Exit Expanded View" : "Expand Graph"}
          </button>
          <span className="viz-badge">{graph.nodes.length} nodes</span>
          <span className="viz-badge">{graph.edges.length} edges</span>
        </div>
      </div>

      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => onNodeSelect?.(node.id)}
          onPaneClick={() => onNodeSelect?.(null)}
          fitView
          minZoom={0.35}
          maxZoom={1.6}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="rgba(51, 65, 85, 0.55)" />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => {
              const graphNode = graph.nodes.find((item) => item.id === node.id);
              return nodeColor(graphNode?.kind ?? "file");
            }}
            style={{
              background: "rgba(15, 23, 42, 0.92)",
              border: "1px solid rgba(51, 65, 85, 0.9)",
            }}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
