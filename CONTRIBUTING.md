# Contributing

Thanks for considering a patch. The card is small and the bar to a
useful PR is low — bug fix, new config option, language pack — but the
verification gate below is hard.

## Dev setup

```bash
git clone https://github.com/rolandzeiner/spinning-wheel-card.git
cd spinning-wheel-card
npm ci           # Node ^24.11 or 26+, npm 11+
```

Day-to-day:

```bash
npm run dev      # vp build --watch — rebuilds dist/spinning-wheel-card.js on save (unminified, with a sourcemap)
npm run build    # = vp build; one-shot production build (minified)
```

For live testing in a Home Assistant install:

1. Install the card via HACS as a custom repository (HACS auto-registers
   the Lovelace resource at `/hacsfiles/spinning-wheel-card/spinning-wheel-card.js`).
2. After each rebuild, copy `dist/spinning-wheel-card.js` into
   `<config>/www/community/spinning-wheel-card/` on the HA host (HACS
   serves that folder at `/hacsfiles/`), and delete the
   `spinning-wheel-card.js.gz` beside it. HACS writes that gzipped copy
   on install and Home Assistant serves it in preference, so without the
   delete the browser keeps getting the old card.
3. Hard-refresh the browser (⌘⇧R / Ctrl⇧R) to pick up the new bytes.
   The resource URL carries the release tag, so iterations on the same
   tag rely on the browser cache being bypassed.

## Verification gate (must pass before PR)

```bash
npm test                         # = vp test run, the unit suite
npx vp check                     # format, lint and strict type-check
npm run build                    # vp build must succeed clean
git diff --exit-code -- dist/    # committed bundle must match that build
node -c dist/spinning-wheel-card.js   # syntax sanity-check
```

Commit `dist/` alongside your `src/` change. HACS serves the committed
bundle directly, so a `src/` edit without a rebuild ships code that no
longer matches the source — the fourth command is what catches it, and
CI fails the build on the same check.

CI runs the same five plus `npm audit --omit=dev --audit-level=high`,
HACS plugin validation, and CodeQL JS/TS analysis.

## Tests

The suites live in `tests/` (Vitest, run by `vp test`; `vite.config.ts`
sets nothing for them). Those that need a DOM opt into one with an
`@vitest-environment happy-dom` docblock; the rest run in plain node.

- `validate.test.ts`, `wheel-math.test.ts`, `friction.test.ts`,
  `editor-helpers.test.ts`, `editor-defaults.test.ts` — pure functions.
- `card.test.ts`, `card-draw.test.ts` — the card itself, mounted, spun
  and painted. happy-dom has no canvas, no Web Audio and no animation
  frames, so `tests/fakes.ts` stands in for them: its canvas records
  every call, and its clock only moves when a test runs frames.
- `editor-save.test.ts` — the editor, driven through `ha-form` events.
- `toolchain.test.ts` — the `vite` override in `package.json` names the
  same version as `vite-plus` (see *Card build*).

A change to what the card does should come with a test that fails
without it. The coverage provider is not a dependency. To measure
coverage, install it at the Vitest version Vite+ bundles (`npx vp
toolchain` names it) without saving it, then run:

```bash
npm i --no-save @vitest/coverage-v8@<that version>
npx vp test run --coverage --coverage.provider=v8 \
  --coverage.reporter=json --coverage.reporter=text-summary '--coverage.include=src/**'
```

That prints a summary and writes `coverage/coverage-final.json`
(gitignored). The next `npm ci` removes the provider again.

## Branching

- All work happens on `dev`. PRs target `dev`.
- The maintainer cuts releases from `main` after a PR from `dev → main`.
- Don't force-push or commit directly to `main`.

## Translations

Add a new language by:

1. Drop a `<code>.json` next to the existing
   `src/localize/languages/*.json` (nine bundled today: en / de / fr / it /
   es / pt / nl / zh / ja). Same key tree, fully translated.
2. Register it in `src/localize/localize.ts` — `import sv from
   "./languages/sv.json";` at the top (a default import: the build emits
   no named exports for JSON, so `import * as sv` would leave the
   language empty), then add an entry to `LANGUAGE_REGISTRY`:
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

`vite.config.ts` holds the whole card toolchain, run through [Vite+](https://viteplus.dev/) (`vp`): `vp build` (Vite library mode on Rolldown), `vp test` (Vitest), and `vp check` (Oxfmt + Oxlint + type-check). The only `devDependencies` are `vite-plus` and `happy-dom`. Vitest, Rolldown and the type-checker all ship inside `vite-plus`, and `typescript` is not installed.

Six things in that config fail silently if you change them:

- The banner must be a **legal** comment — `/*! ... */` — with `comments: { legal: true }`. A `//` banner is stripped by the minifier and nothing tells you; only the built file's first bytes do.
- **`minify` lives on `rolldownOptions.output`, with `dropConsole: false`.** Vite's library mode skips whitespace minification for ES output, so `build.minify` alone ships a larger bundle. `dropConsole` is all-or-nothing, and every `console.warn` here sits in a `catch` block, where dropping it turns a caught error into a silent one.
- **`json` turns off named exports and `JSON.parse` output.** The language packs are default-imported whole; with Vite's defaults the five largest blocks ship as quoted-key `JSON.parse('…')` strings, about 1 kB more gzipped.
- **Dev vs prod comes from `--mode development`** (`npm run dev`). A plain `vp build` is production: minified, no sourcemap.
- **`fmt.embeddedLanguageFormatting` stays `"off"`.** Otherwise Oxfmt reformats Lit `html`/`css` templates and changes the whitespace inside rendered elements, which is a DOM change, not a style change.
- **Decorators are not configured.** Rolldown reads `tsconfig.json` itself and enables Lit's legacy decorators from it. If that ever regresses, class fields overwrite Lit's accessors and reactivity dies while the build stays green — diff a built bundle's Lit reactive-property list to catch it.

**The `vite` override in `package.json` must name the same version as `vite-plus`.** It keeps npm from installing upstream Vite next to Vite+'s core. Dependabot bumps `vite-plus` but not the override, and `tests/toolchain.test.ts` fails until you bump both.

The build does not type-check. `vp check` is the only thing between a type error and a green build.

## Style

- TypeScript strict (the `tsconfig.json` flags are not negotiable).
- No new runtime dependencies without discussion. The card is
  intentionally a single npm dep (`lit`) plus build-time tooling.
- Comments only when the WHY is non-obvious — well-named identifiers
  carry the WHAT.
