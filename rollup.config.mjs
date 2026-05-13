import typescript from "@rollup/plugin-typescript";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import json from "@rollup/plugin-json";

const dev = !!process.env.ROLLUP_WATCH;

const banner =
  "// Spinning Wheel Card — bundled by Rollup. Edit sources in src/, then `npm run build`.";

// Suppress noisy node_modules `this` warnings from CommonJS internals
// after Rollup converts them. Real warnings still surface.
const onwarn = (warning, warn) => {
  if (
    warning.code === "THIS_IS_UNDEFINED" &&
    warning.id?.includes("/node_modules/")
  ) {
    return;
  }
  warn(warning);
};

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
    nodeResolve(),
    commonjs(),
    typescript(),
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
  onwarn,
};
