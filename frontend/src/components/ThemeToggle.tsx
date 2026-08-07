"use client";

import { useEffect, useState } from "react";

import { getTheme, toggleTheme, type Theme } from "@/src/utils/theme";

/* Deliberately understated: a single hairline square that swaps a sun for a
   moon. It reads as part of the rule-and-ink system rather than a feature. */

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setLocal] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  // The server cannot know the stored theme, so the icon is only rendered
  // after mount. Rendering it eagerly would guarantee a hydration mismatch.
  useEffect(() => {
    setLocal(getTheme());
    setMounted(true);
  }, []);

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      onClick={() => setLocal(toggleTheme())}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      <span className="theme-toggle-icon" aria-hidden>
        {mounted && (
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
            {isDark ? (
              <>
                <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
                  <line
                    key={angle}
                    x1="8"
                    y1="1.4"
                    x2="8"
                    y2="3.1"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    transform={`rotate(${angle} 8 8)`}
                  />
                ))}
              </>
            ) : (
              <path
                d="M13.4 9.8A5.9 5.9 0 0 1 6.2 2.6a5.9 5.9 0 1 0 7.2 7.2Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            )}
          </svg>
        )}
      </span>
    </button>
  );
}
