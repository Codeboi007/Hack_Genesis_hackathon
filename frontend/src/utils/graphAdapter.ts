import { DocsResponse, GraphPayload } from "@/lib/types";

export type GraphDatasetKey =
  | "dependency_graph"
  | "execution_flowchart"
  | "knowledge_graph";

export type AdaptedGraphNode = {
  id: string;
  label: string;
  path: string;
  kind: string;
  group: string;
  depth: number;
  inbound: number;
  outbound: number;
  degree: number;
};

export type AdaptedGraphEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
};

export type TreeNode = {
  id: string;
  name: string;
  path: string;
  type: "folder" | "file";
  children: TreeNode[];
  fileCount: number;
  depth: number;
};

export type VisualizationBundle = {
  graph: {
    nodes: AdaptedGraphNode[];
    edges: AdaptedGraphEdge[];
  };
  tree: TreeNode;
  stats: {
    fileCount: number;
    folderCount: number;
    edgeCount: number;
    densestNodeId: string | null;
  };
};

export const GROUP_PALETTE = [
  "#7dd3fc",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#fb7185",
  "#f97316",
  "#2dd4bf",
];

type MutableTreeNode = {
  id: string;
  name: string;
  path: string;
  type: "folder" | "file";
  children: MutableTreeNode[];
  fileCount: number;
  depth: number;
};

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function uniquePaths(docs: DocsResponse): string[] {
  const seen = new Set<string>();
  const add = (value: string) => {
    const path = normalizePath(value);
    if (path) seen.add(path);
  };

  const graphs = [
    docs.dependency_graph,
    docs.execution_flowchart,
    docs.knowledge_graph,
  ];

  for (const graph of graphs) {
    for (const node of graph?.nodes ?? []) add(node.id || node.label);
    for (const edge of graph?.edges ?? []) {
      add(edge.source);
      add(edge.target);
    }
  }

  for (const path of Object.keys(docs.docstrings ?? {})) add(path);
  for (const path of Object.keys(docs.modular_docs ?? {})) add(path);

  return [...seen].sort((a, b) => a.localeCompare(b));
}

function inferNodeKind(nodeKind: string, path: string): string {
  const normalizedKind = nodeKind.toLowerCase();
  if (normalizedKind.startsWith("group:")) return "module";
  const extension = path.split(".").pop()?.toLowerCase();

  if (extension === "tsx" || extension === "jsx") return "component";
  if (extension === "ts" || extension === "js") return "module";
  if (extension === "py") return "service";
  return normalizedKind || "file";
}

function getGroup(path: string): string {
  const [first] = path.split("/");
  return first || "root";
}

export function getGroupColor(group: string): string {
  let hash = 0;
  for (let index = 0; index < group.length; index += 1) {
    hash = (hash * 31 + group.charCodeAt(index)) >>> 0;
  }
  return GROUP_PALETTE[hash % GROUP_PALETTE.length];
}

export function getNodeGroupFromPath(path: string): string {
  return getGroup(path);
}

export function adaptGraphPayload(graph: GraphPayload): VisualizationBundle["graph"] {
  const nodeMap = new Map<string, AdaptedGraphNode>();
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  const edgeSeen = new Set<string>();
  const edges: AdaptedGraphEdge[] = [];

  for (const edge of graph.edges ?? []) {
    const source = normalizePath(edge.source);
    const target = normalizePath(edge.target);
    if (!source || !target) continue;

    const key = `${source}->${target}:${edge.label ?? ""}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);

    outbound.set(source, (outbound.get(source) ?? 0) + 1);
    inbound.set(target, (inbound.get(target) ?? 0) + 1);

    edges.push({
      id: key,
      source,
      target,
      label: edge.label ?? "",
    });
  }

  for (const node of graph.nodes ?? []) {
    const path = normalizePath(node.id || node.label);
    if (!path) continue;

    nodeMap.set(path, {
      id: path,
      path,
      label: node.label || path.split("/").pop() || path,
      kind: inferNodeKind(node.kind, path),
      group: getGroup(path),
      depth: path.split("/").length - 1,
      inbound: 0,
      outbound: 0,
      degree: 0,
    });
  }

  for (const edge of edges) {
    if (!nodeMap.has(edge.source)) {
      nodeMap.set(edge.source, {
        id: edge.source,
        path: edge.source,
        label: edge.source.split("/").pop() || edge.source,
        kind: inferNodeKind("file", edge.source),
        group: getGroup(edge.source),
        depth: edge.source.split("/").length - 1,
        inbound: 0,
        outbound: 0,
        degree: 0,
      });
    }

    if (!nodeMap.has(edge.target)) {
      nodeMap.set(edge.target, {
        id: edge.target,
        path: edge.target,
        label: edge.target.split("/").pop() || edge.target,
        kind: inferNodeKind("file", edge.target),
        group: getGroup(edge.target),
        depth: edge.target.split("/").length - 1,
        inbound: 0,
        outbound: 0,
        degree: 0,
      });
    }
  }

  const nodes = [...nodeMap.values()]
    .map((node) => {
      const inCount = inbound.get(node.id) ?? 0;
      const outCount = outbound.get(node.id) ?? 0;
      return {
        ...node,
        inbound: inCount,
        outbound: outCount,
        degree: inCount + outCount,
      };
    })
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.path.localeCompare(b.path);
    });

  return { nodes, edges };
}

export function buildTree(paths: string[]): TreeNode {
  const root: MutableTreeNode = {
    id: "root",
    name: "repository",
    path: "",
    type: "folder",
    children: [],
    fileCount: 0,
    depth: 0,
  };

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (!path) continue;

    const segments = path.split("/");
    let cursor = root;

    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      const nextPath = segments.slice(0, index + 1).join("/");
      let child = cursor.children.find((item) => item.name === segment);

      if (!child) {
        child = {
          id: nextPath,
          name: segment,
          path: nextPath,
          type: isFile ? "file" : "folder",
          children: [],
          fileCount: 0,
          depth: index + 1,
        };
        cursor.children.push(child);
      }

      if (isFile) {
        child.type = "file";
      }

      cursor = child;
    });
  }

  const finalize = (node: MutableTreeNode): TreeNode => {
    const children = node.children
      .map(finalize)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const fileCount =
      node.type === "file"
        ? 1
        : children.reduce((total, child) => total + child.fileCount, 0);

    return {
      ...node,
      children,
      fileCount,
    };
  };

  return finalize(root);
}

function countFolders(node: TreeNode): number {
  return (
    (node.type === "folder" ? 1 : 0) +
    node.children.reduce((total, child) => total + countFolders(child), 0)
  );
}

export function createVisualizationBundle(
  docs: DocsResponse,
  graphKey: GraphDatasetKey,
): VisualizationBundle {
  const graph = adaptGraphPayload(docs[graphKey]);
  const tree = buildTree(uniquePaths(docs));
  const densestNode = graph.nodes[0]?.id ?? null;

  return {
    graph,
    tree,
    stats: {
      fileCount: tree.fileCount,
      folderCount: Math.max(countFolders(tree) - 1, 0),
      edgeCount: graph.edges.length,
      densestNodeId: densestNode,
    },
  };
}

export function getConnectedNodeIds(
  graph: VisualizationBundle["graph"],
  nodeId: string | null,
): Set<string> {
  const connected = new Set<string>();
  if (!nodeId) return connected;

  connected.add(nodeId);
  for (const edge of graph.edges) {
    if (edge.source === nodeId) connected.add(edge.target);
    if (edge.target === nodeId) connected.add(edge.source);
  }
  return connected;
}
