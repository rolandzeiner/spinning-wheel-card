# Contributing

Thanks for considering a patch. The card is small and the bar to a
useful PR is low — bug fix, new config option, language pack — but the
verification gate below is hard.

## Dev setup

```bash
git clone https://github.com/rolandzeiner/spinning-wheel-card.git
cd spinning-wheel-card
npm install
```

Day-to-day:

```bash
npm run dev      # rolldown watch — rebuilds dist/spinning-wheel-card.js on save
npm run build    # one-shot production build (rolldown, minified)
```

For live testing in a Home Assistant install:

1. Install the card via HACS as a custom repository (HACS auto-registers
   the Lovelace resource at `/hacsfiles/spinning-wheel-card/spinning-wheel-card.js`).
2. After each rebuild, copy `dist/spinning-wheel-card.js` to
   `<config>/hacsfiles/spinning-wheel-card/spinning-wheel-card.js` on the HA
   host — that's where HACS serves it from. Hard-refresh the browser
   (⌘⇧R / Ctrl⇧R) to pick up the new bytes; HACS caches per version
   tag, so dev iterations on the same tag rely on the browser cache
   being bypassed.

## Verification gate (must pass before PR)

```bash
npm test                         # vitest unit suite
npx tsc --noEmit                 # strict type-check
npm run build                    # rolldown must succeed clean
git diff --exit-code -- dist/    # committed bundle must match that build
node -c dist/spinning-wheel-card.js   # syntax sanity-check
```

Commit `dist/` alongside your `src/` change. HACS serves the committed
bundle directly, so a `src/` edit without a rebuild ships code that no
longer matches the source — the fourth command is what catches it, and
CI fails the build on the same check.

CI runs the same five plus `npm audit --omit=dev --audit-level=high`,
HACS plugin validation, and CodeQL JS/TS analysis.

## Branching

- All work happens on `dev`. PRs target `dev`.
- The maintainer cuts releases from `main` after a PR from `dev → main`.
- Don't force-push or commit directly to `main`.

## Translations

Add a new language by:

1. Drop a `<code>.json` next to the existing
   `src/localize/languages/*.json` (nine bundled today: en / de / fr / it /
   es / pt / nl / zh / ja). Same key tree, fully translated.
2. Register it in `src/localize/localize.ts` — `import * as sv from
   "./languages/sv.json";` at the top, then add an entry to
   `LANGUAGE_REGISTRY`:
   ```ts
   { code: "sv", nativeName: "Svenska", dict: sv },
   ```
   That single edit drives both the lookup map AND the editor's
   language dropdown — no second list to keep in sync.
3. `npm run build` and confirm the picker / status / editor / confirmation
   prompts switch.

Missing keys fall back to English, so a partial translation is still a
useful PR.

## Card build

The bundle is built by **Rolldown** (`rolldown.config.mjs`). Rolldown does transpilation, minification, module resolution and JSON natively, so the whole `devDependencies` list is `rolldown` + `typescript` + `vitest` + `happy-dom` — the `@rollup/plugin-*` stack (`swc`, `terser`, `node-resolve`, `json`) and `@swc/core` were **deleted** in the 2026-09 migration, not replaced.

Three things in that config fail silently if you change them:

- The banner must be a **legal** comment — `/*! ... */` — with `comments: { legal: true }`. A `//` banner is stripped by the minifier and nothing tells you; only the built file's first bytes do.
- **`dropConsole` stays `false`.** Rolldown's option is a boolean, not terser's per-method array, so it is all-or-nothing — and every `console.warn` here sits in a `catch` block, where dropping it turns a caught error into a silent one.
- **Decorators are not configured.** Rolldown reads `tsconfig.json` itself and enables Lit's legacy decorators from it. If that ever regresses, class fields overwrite Lit's accessors and reactivity dies while the build stays green — diff a built bundle's Lit reactive-property list to catch it.

Rolldown does not type-check. `npx tsc --noEmit` is the only thing between a type error and a green build.

## Style

- TypeScript strict (the `tsconfig.json` flags are not negotiable).
- No new runtime dependencies without discussion. The card is
  intentionally a single npm dep (`lit`) plus build-time tooling.
- Comments only when the WHY is non-obvious — well-named identifiers
  carry the WHAT.
