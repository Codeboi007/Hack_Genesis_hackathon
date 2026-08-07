"use client";

import { useEffect, useState } from "react";

/* Theme is stored on <html data-theme> so CSS can switch tokens without a
   re-render, and mirrored into localStorage so the choice survives reloads.
   The initial paint is handled by an inline script in app/layout.tsx — this
   module only takes over once React has hydrated. */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "argus-theme";

/** Subscribers are notified on every change so canvas/SVG views can repaint. */
const listeners = new Set<(theme: Theme) => void>();

export function getTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the theme still applies for this session.
  }
  for (const listener of listeners) listener(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/**
 * Current theme, re-rendering the caller whenever it changes.
 *
 * Returns "light" on the server and for the first client render so markup
 * matches; the effect corrects it immediately after mount. Views that paint
 * imperatively (D3, canvas) should depend on this value so they repaint.
 */
export function useTheme(): Theme {
  const [theme, setLocal] = useState<Theme>("light");

  useEffect(() => {
    setLocal(getTheme());
    const listener = (next: Theme) => setLocal(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return theme;
}
