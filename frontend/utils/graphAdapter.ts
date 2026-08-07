import { GraphPayload, GraphNode } from "@/lib/types";

export type ViewGraphNode = {
  id: string;
  label: string;
  kind: string;
  filePath: string;
};

export type ViewGraphLink = {
  source: string;
  target: string;
  label?: string;
};

export type ViewGraphData = {
  nodes: ViewGraphNode[];
  links: ViewGraphLink[];
};

export type TreeNode = {
  id: string;
  name: string;
  type: "folder" | "file";
  children?: TreeNode[];
  filePath?: string;
};

function normalizePath(raw?: string): string {
  if (!raw) return "";
  return raw.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function deriveFilePath(node: GraphNode): string {
  const labelPath = normalizePath(node.label);
  if (labelPath.includes("/")) return labelPath;
  return normalizePath(node.id) || labelPath || "unknown";
}

export function toGraphData(payload?: GraphPayload | null): ViewGraphData {
  if (!payload) return { nodes: [], links: [] };

  const nodes = payload.nodes.map((node) => ({
    id: node.id,
    label: node.label || node.id,
    kind: node.kind || "default",
    filePath: deriveFilePath(node),
  }));

  const knownIds = new Set(nodes.map((node) => node.id));
  const links = payload.edges
    .filter((edge) => knownIds.has(edge.source) && knownIds.has(edge.target))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.label,
    }));

  return { nodes, links };
}

function ensureFolderNode(root: TreeNode, part: string, pathAcc: string): TreeNode {
  root.children ??= [];
  const existing = root.children.find((node) => node.type === "folder" && node.name === part);
  if (existing) return existing;

  const created: TreeNode = {
    id: `folder:${pathAcc}`,
    name: part,
    type: "folder",
    children: [],
    filePath: pathAcc,
  };
  root.children.push(created);
  return created;
}

export function toTreeData(payload?: GraphPayload | null): TreeNode {
  const graph = toGraphData(payload);
  const root: TreeNode = {
    id: "root",
    name: "Repository",
    type: "folder",
    children: [],
  };

  for (const node of graph.nodes) {
    const path = normalizePath(node.filePath);
    const parts = path.split("/").filter(Boolean);

    if (parts.length === 0) {
      root.children?.push({
        id: `file:${node.id}`,
        name: node.label,
        type: "file",
        filePath: node.filePath,
      });
      continue;
    }

    let cursor = root;
    const folders = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];

    for (let i = 0; i < folders.length; i += 1) {
      const folderPath = folders.slice(0, i + 1).join("/");
      cursor = ensureFolderNode(cursor, folders[i], folderPath);
    }

    cursor.children ??= [];
    const fileId = `file:${node.id}`;
    if (!cursor.children.some((child) => child.id === fileId)) {
      cursor.children.push({
        id: fileId,
        name: fileName,
        type: "file",
        filePath: node.filePath,
      });
    }
  }

  const sortTree = (treeNode: TreeNode) => {
    if (!treeNode.children || treeNode.children.length === 0) return;
    treeNode.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    treeNode.children.forEach(sortTree);
  };

  sortTree(root);
  return root;
}
