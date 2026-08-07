import type { Metadata, Viewport } from "next";
import { Inter_Tight, Instrument_Serif, JetBrains_Mono } from "next/font/google";

import "./globals.css";

/* Self-hosted at build time: no render-blocking request to a third-party CSS
   host, no flash of fallback text, and the exact weights we actually use. */
const sans = Inter_Tight({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-serif",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays available: the visualisations handle their own gestures,
  // but locking the page zoom would fail users who need to magnify text.
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0f" },
  ],
};

export const metadata: Metadata = {
  title: "ARGUS — Autonomous Review for GitHub Understanding & Security",
  description:
    "ARGUS reads a repository the way a senior engineer would: multi-agent code review, security findings, and generated documentation with a live dependency map.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

/* Runs before first paint, so a stored dark preference never flashes white.
   Kept tiny and dependency-free — it is inlined into the document head. */
const THEME_INIT = `(function(){try{var t=localStorage.getItem("argus-theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
