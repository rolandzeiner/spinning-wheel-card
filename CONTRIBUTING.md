# Contributing to Spinning Wheel Card

Thanks for taking a look. This repo is a Lovelace card for Home Assistant. Everything you need to work on it is on this page, and the gate in *Verification gate* has to pass before a change lands.

## Quick start

```bash
git clone https://github.com/rolandzeiner/spinning-wheel-card.git
cd spinning-wheel-card
npm ci && npm run build
```

Before a PR, run the gate in *Verification gate*. It is what CI runs, so failing locally only costs you a push.

## Branching and releases

- Work on `dev`; PRs target `dev`. Nothing is committed or force-pushed to `main`.
- For anything bigger than a fix, open an issue first so the shape is agreed before the code is written.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. A subject line, then bullets that say what changed and why.
- The built bundle is committed and travels with the `src/` change that produced it: users install through the Marketplace and never run `npm`, and CI fails when the committed bundle differs from a fresh build by a byte.
- Releases are the maintainer's: a `dev → main` PR, squash-merged, then a tag from `main`. Publishing the release runs `release.yml`, which attaches the built `dist/*.js`. If the job fails, `gh workflow run release.yml -f tag=vX.Y.Z` re-runs it against the existing tag.
- Contributions are accepted under the repo's MIT licence.

## Card toolchain

The card lives in `src/` and builds to `dist/spinning-wheel-card.js`. Its whole toolchain runs through [Vite+](https://viteplus.dev/) (`vp`), configured in `vite.config.ts`: `vp build` (Vite library mode on Rolldown), `vp test` (Vitest) and `vp check` (Oxfmt, Oxlint and the type-check). The only card `devDependencies` are `vite-plus` and `happy-dom`; Vitest, Rolldown and the type-checker ship inside `vite-plus`, and `typescript` is not installed. `npx vp` runs the copy in `node_modules`; a global `vp` works too.

| Command | What it does |
|---|---|
| `npm run dev` | `vp build --watch --mode development`: rebuilds `dist/spinning-wheel-card.js` on save, unminified, with a sourcemap |
| `npm run build` | `vp build`: one-shot production build, minified |
| `npm test` | `vp test run`: the unit suite |
| `npm run check` | `vp check`: format, lint and the type-check |
| `npx vp check --fix` | the same, applying the fixes it can |

**Node.** Node 24.11 or newer (26 works too) and npm 11.

**The committed bundle.** Commit the built bundle. End users install through the Marketplace and never run `npm`, so `dist/spinning-wheel-card.js` is tracked, and `release.yml` attaches it from the tagged tree without rebuilding. CI asserts the committed bundle matches a fresh build byte for byte; a `src/` edit without a rebuild ships code that no longer matches its source. A dev build writes `.map` files next to it; they are gitignored.

**The config traps.** Things in `vite.config.ts` that fail silently if you change them:

- The banner must be a **legal** comment, `/*! ... */`, with `comments: { legal: true }`. The minifier strips a `//` banner without a word; only the built file's first bytes show it.
- **`minify` lives on `rolldownOptions.output`, with `dropConsole: false`.** Vite's library mode skips whitespace minification for ES output, so `build.minify` alone ships the bundle with its whitespace left in. `dropConsole` is all-or-nothing, and the `console.*` calls here sit in `catch` blocks, where dropping them turns a caught error into a silent one.
- **Dev vs prod comes from `--mode development`** (`npm run dev`). A plain `vp build` is production: minified, no sourcemap.
- **`fmt.embeddedLanguageFormatting` stays `"off"`.** Otherwise Oxfmt reformats Lit `html` and `css` templates and changes the whitespace inside rendered elements, which is a DOM change, not a style change.
- **Decorators are not configured.** Rolldown reads `tsconfig.json` itself and enables Lit's legacy decorators from it. If that ever regresses, class fields overwrite Lit's accessors and reactivity dies while the build stays green; diff a built bundle's Lit reactive-property list to catch it.
- **`lint.plugins` replaces Oxlint's defaults.** It names `typescript`, `unicorn` and `oxc` next to `vitest`; drop one and its rules stop running without a word. The `vitest/*` rules fail a committed `.only` or `.skip`, a test without an assertion, a duplicate title, an `expect` inside an `if` and a bare `toThrow()`, and `reportUnusedDisableDirectives` fails a disable comment that no longer suppresses anything.
- **`lint.options.denyWarnings: true`.** Without it `vp check` exits 0 on warnings, and CI lets them through.
- **`codeSplitting: false`.** The card is one file; a dashboard resource can't load a second chunk the bundler decided on.
- **`json` turns off named exports and `JSON.parse` output** (`namedExports: false, stringify: false`). The language packs are default-imported whole; with Vite's defaults the largest blocks ship as quoted-key `JSON.parse('…')` strings, about 1 kB more gzipped.

**The `vite` override.** The `vite` override in `package.json` must name the same version as `vite-plus`. It keeps npm from installing upstream Vite next to Vite+'s core. Dependabot bumps `vite-plus` but not the override, and `tests/toolchain.test.ts` fails until both match. Bump with `npx --package=vite-plus@<new> vp migrate --no-interactive`, which moves both; `npm install vite-plus@<new>` fails with ERESOLVE.

**The only type-check.** The build does not type-check. `vp check` is the only thing between a type error and a green build, which is why the gate runs it as its own step. It also catches a backtick inside a Lit `css` or `html` template, comments included, which ends the template early and fails the card at load while the build stays green.

**The browser floor.** `tsconfig.json`'s `lib` is the card's browser floor: `es2022`, with `dom`. ES2023 built-ins such as `toSorted()` are out of reach without a polyfill. Raising the floor raises the browser requirement in the README's Requirements section; change both together.

### Trying it in Home Assistant

1. Install the card through the Marketplace (HACS) once, so the dashboard resource exists.
2. After each rebuild, copy `dist/spinning-wheel-card.js` into `<config>/www/community/spinning-wheel-card/` on the HA host, and delete the `spinning-wheel-card.js.gz` beside it. The install leaves that gzipped copy there and Home Assistant serves it in preference, so without the delete the browser keeps getting the old card.
3. Hard-refresh the browser (⌘⇧R / Ctrl⇧R). The resource URL doesn't change between rebuilds, so only a bypassed browser cache fetches the new file.

## Verification gate

```bash
npx vp check                     # format, lint and the only type-check
npm test                         # vp test run
npm run build                    # must succeed clean
git diff --exit-code -- dist/    # the committed bundle matches that build
node -c dist/spinning-wheel-card.js
```

CI runs the same plus `npm audit --omit=dev --audit-level=high`, HACS validation and CodeQL, which analyses the JavaScript and TypeScript and the workflows (`actions`) on pushes to `main` and `dev`, on pull requests to `main`, and weekly. Failing locally only costs you a push.

`npx vp check` is the only type-check anywhere. The build strips types without checking them, so a type error builds cleanly all the way to a shipped bundle.

## Tests

The suites live in `tests/` (Vitest, run by `vp test`; `vite.config.ts`
sets nothing for them). Those that need a DOM opt into one with an
`@vitest-environment happy-dom` docblock; the rest run in plain node.

- `validate.test.ts`, `wheel-math.test.ts`, `friction.test.ts`,
  `editor-helpers.test.ts`, `editor-defaults.test.ts`,
  `editor-fields.test.ts`: pure functions. `editor-fields.test.ts` also
  fails when an option with a default has no field in the editor.
- `click-sounds.test.ts`: the six click voices, against an audio
  context that records what they schedule.
- `card.test.ts`, `card-draw.test.ts`: the card itself, mounted, spun
  and painted. happy-dom has no canvas, no Web Audio and no animation
  frames, so `tests/fakes.ts` stands in for them: its canvas records
  every call, and its clock only moves when a test runs frames.
- `editor-save.test.ts`: the editor, driven through `ha-form` events
  and its segment rows. happy-dom has no `ha-expansion-panel`, so the
  groups are drawn open there; `editor-panels.test.ts` covers the panels
  with a stand-in element.
- `grid-cell.test.ts`: the card fills its sections-view cell only when
  HA sets a `layout`, so the add-card picker preview keeps its own
  height. happy-dom does no layout, so it checks the CSS text.
- `toolchain.test.ts`: the `vite` override in `package.json` names the
  same version as `vite-plus` (see *Card toolchain*).

A change to what the card does comes with a test that fails without it.

### Coverage

There is no coverage gate, and the provider is not a dependency. To measure
coverage, install it once at the Vitest version Vite+ bundles:

```bash
V=$(npx vp toolchain vitest | grep -oE 'vitest@[0-9.]+' | head -1 | cut -d@ -f2)
npm i --no-save @vitest/coverage-v8@"$V"
npx vp test run --coverage --coverage.provider=v8 --coverage.reporter=text \
  '--coverage.include=src/**/*.ts' '--coverage.exclude=src/**/*.test.ts'
```

`--no-save` leaves `package.json` and the lockfile alone; the next `npm ci`
removes the provider. Add `--coverage.reporter=json` to write
`coverage/coverage-final.json` (gitignored).

## Version sync

The release number is `package.json` `version`, and the maintainer bumps it when cutting a release. The tag carries the same number. A pre-release has the final release's number and GitHub's pre-release flag, never a `-beta` suffix.

## Dependencies

| Package | Pin | Why |
|---|---|---|
| `vite-plus` | exact, `package.json` | it decides what the committed bundle looks like; the `vite` override names the same version |
| `happy-dom` | exact | it decides what the DOM suites see; the sibling card repos keep one version |
| `lit` | caret | maintained, keeps semver |

- **Dependabot's blind spot.** It bumps `vite-plus` and leaves the `vite` override alone. `tests/toolchain.test.ts` catches the mismatch.
- **Runtime vs dev.** What the build inlines into the bundle is a `dependency` (`lit`); a build-time tool is a `devDependency` even though the build needs it. CI's `npm audit --omit=dev` only means something because of that split.
- **Adding a dependency.** The bundle loads on every dashboard, so a new runtime dependency is discussed in an issue first; today the card has `lit` alone. Its licence must be compatible with MIT and its notice must survive the build (`comments: { legal: true }` keeps the `@license` comments).

## Translations

Add a new language by:

1. Drop a `<code>.json` next to the existing
   `src/localize/languages/*.json` (nine bundled today: en / de / fr / it /
   es / pt / nl / zh / ja). Same key tree, fully translated.
2. Register it in `src/localize/localize.ts`, `import sv from
   "./languages/sv.json";` at the top (a default import: the build emits
   no named exports for JSON, so `import * as sv` would leave the
   language empty), then add an entry to `LANGUAGE_REGISTRY`:
   ```ts
   { code: "sv", nativeName: "Svenska", dict: sv },
   ```
   That single edit drives both the lookup map AND the editor's
   language dropdown, no second list to keep in sync.
3. Run `npm test`, which compares keys and placeholders with English, then
   `npm run build` and confirm the picker, status, editor and confirmation
   prompts switch.

Missing keys fall back to English, so a partial translation is still a
useful PR. German uses du, never Sie.

## Style

- TypeScript strict; the `tsconfig.json` flags are not negotiable, and `vp check` reports no warnings (`denyWarnings`).
- Comments say why, not what; identifiers carry the what.
- The browser floor is ES2022 (see *Card toolchain*).
- The only runtime dependency is `lit`; adding one goes through *Dependencies*.
- German copy uses du.

## Reporting issues

Open an issue with:

- your Home Assistant version and the card version (the console banner, or the `?v=` on the resource)
- your browser
- the card's YAML and a screenshot

A security problem goes through **Report a vulnerability** under the repository's **Security** tab, not a public issue.
