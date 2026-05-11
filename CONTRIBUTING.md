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
npm run dev      # rollup watch — rebuilds dist/spinning-wheel-card.js on save
npm run build    # one-shot production build (terser-minified)
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
npx tsc --noEmit                 # strict type-check
npm run build                    # rollup must succeed clean
node -c dist/spinning-wheel-card.js   # syntax sanity-check
```

CI runs the same three plus `npm audit --omit=dev --audit-level=high`,
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
2. Register it in `src/localize/localize.ts`:
   ```ts
   import * as sv from "./languages/sv.json";
   const languages = { en, de, fr, it, es, pt, nl, zh, ja, sv };
   ```
3. `npm run build` and confirm the picker / status / editor / confirmation
   prompts switch.

Missing keys fall back to English, so a partial translation is still a
useful PR.

## Style

- TypeScript strict (the `tsconfig.json` flags are not negotiable).
- No new runtime dependencies without discussion. The card is
  intentionally a single npm dep (`lit`) plus build-time tooling.
- Comments only when the WHY is non-obvious — well-named identifiers
  carry the WHAT.
