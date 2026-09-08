import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import json from "@rollup/plugin-json";

const dev = !!process.env.ROLLUP_WATCH;

const banner =
  "// Spinning Wheel Card — bundled by Rollup. Edit sources in src/, then `npm run build`.";

export default {
  input: "src/spinning-wheel-card.ts",
  output: {
    file: "dist/spinning-wheel-card.js",
    format: "es",
    sourcemap: dev,
    banner,
    inlineDynamicImports: true,
  },
  plugins: [
    // Load-bearing, and it fails quietly if dropped: without it Rollup can't
    // resolve the bare `lit` specifier, so it treats lit as external and
    // still exits 0 — emitting a bundle that opens with `import ... from
    // "lit"`, which 404s in the browser. The only signal is an "Unresolved
    // dependencies" warning. Don't remove it on the strength of a green build.
    nodeResolve(),
    typescript(),
    // src/localize/localize.ts imports the nine language files as JSON.
    json(),
    // Strip `console.warn` / `console.error` calls from prod bundles —
    // the card's only console writes are benign instrumentation (failed
    // callWS, failed icon resolve) that surface as user-visible no-ops
    // anyway. Keeps the bundle a touch smaller and the user's HA log clean.
    !dev &&
      terser({
        format: { comments: /Spinning Wheel Card/ },
        compress: { drop_console: ["warn", "error"] },
      }),
  ].filter(Boolean),
};
