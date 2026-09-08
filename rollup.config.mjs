// Transpiler note: this was @rollup/plugin-typescript until TypeScript 7.
// TS 7 is the Go-native compiler and its npm package no longer ships the JS
// compiler API — `require("typescript")` now resolves to lib/version.cjs, so
// ts.createProgram / ts.ScriptTarget are undefined and that plugin dies at
// load with "Cannot read properties of undefined (reading 'ES2015')".
// @rollup/plugin-typescript has had no release since 2025-10, i.e. none that
// knows about TS 7. swc transpiles instead; `tsc --noEmit` still type-checks.
import { readFileSync } from "node:fs";

import { swc } from "@rollup/plugin-swc";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import json from "@rollup/plugin-json";

const dev = !!process.env.ROLLUP_WATCH;

// Derive swc's transpile settings from tsconfig.json rather than restating
// them. swc has its own decorator implementation, so if these ever disagree
// with tsconfig the bundle silently stops matching what tsc type-checked —
// and the failure mode (Lit reactivity quietly dead) does not look like a
// config bug. Reading them here makes that class of drift impossible.
const tsconfig = JSON.parse(readFileSync("./tsconfig.json", "utf8"));
const { target, experimentalDecorators, useDefineForClassFields } =
  tsconfig.compilerOptions;

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
    // `extensions` is required by the swc switch: @rollup/plugin-typescript
    // resolved extensionless relative imports (`./friction` -> friction.ts)
    // itself, swc does not, so Rollup must be told .ts is resolvable or the
    // build fails with "Could not resolve ./friction".
    nodeResolve({ extensions: [".ts", ".mjs", ".js", ".json"] }),
    swc({
      // Scope to .ts only. Without this swc also grabs src/localize/languages/
      // *.json (now resolvable via nodeResolve's `extensions`) and tries to
      // parse them as TypeScript, failing on the first translation string.
      include: /\.ts$/,
      swc: {
        jsc: {
          // Lit 3's @customElement / @property are LEGACY (experimental)
          // decorators, and useDefineForClassFields must stay false or class
          // fields overwrite Lit's accessors and reactivity silently dies.
          // Both come from tsconfig above. swc does no type-checking at all —
          // `tsc --noEmit` is the only thing between a type error and a green
          // build, which is why CI runs it as a separate step.
          target,
          parser: { syntax: "typescript", decorators: experimentalDecorators },
          transform: {
            legacyDecorator: experimentalDecorators,
            decoratorMetadata: false,
            useDefineForClassFields,
          },
        },
      },
    }),
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
