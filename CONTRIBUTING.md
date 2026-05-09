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

1. Register `/local/community/spinning-wheel-card/spinning-wheel-card.js`
   (type: JS module) as a Lovelace resource.
2. Copy the bundle into `<config>/www/community/spinning-wheel-card/`
   on every rebuild.

A small rsync wrapper that automates step 2 over SSH makes the loop
much faster — tailor it to your host and path conventions.

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
   `src/localize/languages/{en,de}.json`. Same key tree, fully
   translated.
2. Register it in `src/localize/localize.ts`:
   ```ts
   import * as fr from "./languages/fr.json";
   const languages = { en, de, fr };
   ```
3. `npm run build` and confirm the picker / status / editor switch.

Missing keys fall back to English, so a partial translation is still a
useful PR.

## Style

- TypeScript strict (the `tsconfig.json` flags are not negotiable).
- No new runtime dependencies without discussion. The card is
  intentionally a single npm dep (`lit`) plus build-time tooling.
- Comments only when the WHY is non-obvious — well-named identifiers
  carry the WHAT.
