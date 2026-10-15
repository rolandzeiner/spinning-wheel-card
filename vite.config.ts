// One config for the whole card toolchain under Vite+ (`vp`): build (Vite 8
// library mode on Rolldown), test (Vitest), lint + type-check (Oxlint with
// tsgolint) and format (Oxfmt).
//
// Decorators are deliberately not configured here. Rolldown reads
// tsconfig.json itself and turns on Lit's legacy (experimental) decorators
// from it.
import { defineConfig } from "vite-plus";

// MUST be a legal comment — `/*! ... */` — not `//`. The minifier strips
// ordinary comments including a `//` banner, silently. `comments: { legal:
// true }` below is the other half of the same requirement.
const banner =
  "/*! Spinning Wheel Card — bundled by Rolldown. Edit sources in src/, then `npm run build`. */";

// Dev vs prod comes from Vite's mode: `npm run dev` passes `--mode
// development`. `vp build --watch` alone still builds production.
export default defineConfig(({ mode }) => {
  const dev = mode === "development";
  return {
    // The language packs are default-imported whole (src/localize), so they
    // need neither a named export per key nor Vite's JSON.parse('…') form,
    // which the "auto" default applies to any value over 10 kB and which
    // quotes every key. With Vite's defaults (namedExports: true,
    // stringify: "auto") the bundle grows by about 1 kB gzipped.
    json: { namedExports: false, stringify: false },
    build: {
      // Library mode: one ES module, no index.html, no hashed file name.
      lib: {
        entry: "src/spinning-wheel-card.ts",
        formats: ["es"],
        fileName: () => "spinning-wheel-card.js",
      },
      // dist/ holds nothing but this build's output, so Vite empties it
      // before each build (the default), and no stale dev .map is left
      // next to a production bundle.
      outDir: "dist",
      copyPublicDir: false,
      target: "es2022",
      sourcemap: dev,
      rolldownOptions: {
        output: {
          banner,
          // HACS installs one file, so never split chunks: a dynamic
          // import() would otherwise emit a second file next to the bundle.
          codeSplitting: false,
          comments: { legal: true },
          // Set on the Rolldown output, not `build.minify`: Vite's library
          // mode skips whitespace minification for ES output. Keep console.*
          // (dropConsole: false): the card's console.warn calls, all in catch
          // blocks, are its only client-side failure signal, and Rolldown's
          // dropConsole is all-or-nothing.
          minify: dev ? false : { compress: { dropConsole: false }, mangle: true, codegen: true },
        },
      },
    },
    fmt: {
      // Leave Lit html/css templates alone. Formatting them rewrites the
      // whitespace inside rendered elements, which changes the DOM.
      embeddedLanguageFormatting: "off",
      // Format everything but the bundle (build output), the Markdown and
      // the workflow YAML, which keep their hand formatting.
      ignorePatterns: ["dist/**", "**/*.md", ".github/**"],
    },
    lint: {
      ignorePatterns: ["dist/**"],
      jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
      rules: {
        "vite-plus/prefer-vite-plus-imports": "error",
        // Opt-in rules from the `suspicious` category; the rest of that
        // category is mostly noise for Lit code (e.g. `_private` names).
        "typescript/no-unnecessary-type-assertion": "error",
        "eslint/no-shadow": "error",
        "unicorn/no-array-sort": "error",
      },
      // typeCheck: `vp check` also reports TypeScript's own diagnostics,
      // which makes it the pipeline's only type-check. src/ gets the full
      // flag set in tsconfig.json; tests/ sit outside its `include` and get
      // only the compiler defaults with `strict`.
      // denyWarnings: a warning fails `vp check` (and CI) instead of
      // scrolling past with exit 0.
      options: { typeAware: true, typeCheck: true, denyWarnings: true },
    },
  };
});
