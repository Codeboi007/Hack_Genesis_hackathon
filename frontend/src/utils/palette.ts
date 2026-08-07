import type { Theme } from "@/src/utils/theme";

/* One source of truth for group colour across the graph, tree and 3D views.

   Two palettes, not one: the deep hues that hold >= 4.5:1 on white collapse
   into mud on a near-black ground, and the luminous hues that read on dark
   are unreadable on paper. Each is tuned against its own substrate. */

const LIGHT_GROUPS: Record<string, string> = {
  backend: "#0b6b3a",
  frontend: "#0f4c81",
  agents: "#8a4b00",
  rag: "#4c2889",
  docs: "#123f8c",
  github: "#9b1c1c",
};

const DARK_GROUPS: Record<string, string> = {
  backend: "#4ade80",
  frontend: "#60a5fa",
  agents: "#fbbf24",
  rag: "#c084fc",
  docs: "#38bdf8",
  github: "#fb7185",
};

const LIGHT_FALLBACK = [
  "#0f4c81",
  "#0b6b3a",
  "#8a4b00",
  "#8e1f5f",
  "#4c2889",
  "#9b1c1c",
  "#9a4a06",
  "#0e6b6b",
];

const DARK_FALLBACK = [
  "#60a5fa",
  "#4ade80",
  "#fbbf24",
  "#f472b6",
  "#c084fc",
  "#fb7185",
  "#fb923c",
  "#2dd4bf",
];

/** Stable across runs and themes: the same group always lands on the same slot. */
function hashOf(group: string): number {
  let hash = 0;
  for (let i = 0; i < group.length; i += 1) {
    hash = (hash * 31 + group.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function groupColor(group: string, theme: Theme = "light"): string {
  const key = group.toLowerCase();
  const named = theme === "dark" ? DARK_GROUPS[key] : LIGHT_GROUPS[key];
  if (named) return named;
  const fallback = theme === "dark" ? DARK_FALLBACK : LIGHT_FALLBACK;
  return fallback[hashOf(group) % fallback.length];
}

/** Backwards-compatible light-only export used by the adapter. */
export const GROUP_PALETTE = LIGHT_FALLBACK;
