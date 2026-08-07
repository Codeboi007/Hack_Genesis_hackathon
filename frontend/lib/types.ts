export type Persona = "Intern" | "Student" | "Frontend Developer" | "Backend Developer";

export type Finding = {
  file: string;
  line: number;
  issue_title: string;
  explanation: string;
  severity: "low" | "medium" | "high" | "critical";
  fix_suggestion: string;
  confidence: number;
  agent: string;
};

export type GraphNode = {
  id: string;
  label: string;
  kind: string;
};

export type GraphEdge = {
  source: string;
  target: string;
  label: string;
};

export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type ReviewResponse = {
  run_id: string;
  persona: Persona;
  findings: Finding[];
  summary: string;
  reviewed_files: string[];
  metadata: Record<string, unknown>;
};

export type DocsResponse = {
  run_id: string;
  persona: Persona;
  docstrings: Record<string, string>;
  readme: string;
  modular_docs: Record<string, string>;
  onboarding_guide: string;
  dependency_graph: GraphPayload;
  execution_flowchart: GraphPayload;
  knowledge_graph: GraphPayload;
  doc_rot_detected: boolean;
  metadata: Record<string, unknown>;
};

export type TokenVerifyResponse = {
  valid: boolean;
  repo_full_name?: string | null;
  default_branch?: string | null;
  encrypted_token?: string | null;
  message: string;
};
