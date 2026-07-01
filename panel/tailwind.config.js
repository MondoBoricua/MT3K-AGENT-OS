/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // MT3K brand palette (from MT3K-WEB global.css) — near-black hue 270 base
        ink: {
          900: "oklch(13% 0.012 270)",
          850: "oklch(16% 0.015 270)",
          800: "oklch(19% 0.018 270)",
          700: "oklch(24% 0.02 270)",
          line: "oklch(30% 0.02 270)",
        },
        accent: "oklch(62% 0.23 25)",       // MT3K brand red (#d4202b family)
        "accent-bright": "oklch(68% 0.25 25)",
        amber: "oklch(80% 0.15 75)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SF Mono", "JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
