# Spinning Wheel Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Version](https://img.shields.io/github/v/release/rolandzeiner/spinning-wheel-card?label=version&color=blue)](https://github.com/rolandzeiner/spinning-wheel-card/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![vibe-coded](https://img.shields.io/badge/vibe-coded-ff69b4?logo=musicbrainz&logoColor=white)](https://en.wikipedia.org/wiki/Vibe_coding)

<p align="center">
  <img src="assets/preview.svg" alt="Spinning wheel preview" width="320" />
</p>

A Lovelace custom card with a click-to-spin / drag-to-flick wheel for Home Assistant. The physics simulate angular momentum: while you drag, the wheel follows the cursor; on release, the recent pointer-move samples are averaged into an angular velocity, and the wheel keeps spinning, decaying via configurable friction until it stops. Pure frontend — no integration, no entities, no backend dependency. Drop the card in any dashboard.

## Features

- **Click-to-spin** — random impulse + random direction. Click again while spinning to **boost** speed (capped at ~6 rev/s).
- **Drag-to-throw** — angular velocity at release determines the spin; sample-averaged over the last 100 ms so a panic-flick doesn't produce a runaway spin.
- **Frame-rate-independent friction** with three presets (`low` / `medium` / `high`). The wheel stops in roughly the same wall-clock time at 30, 60, or 120 fps — `ω *= friction^(60·dt)`.
- **Per-segment configuration**: 4–24 segments, optional weights for variable widths, optional labels, optional colours, optional label-text colours. Anything shorter than `segments` cycles around the wheel.
- **Same-label-same-colour** — segments sharing a label automatically share a fill colour and label-text colour, so cycling labels (e.g. `Yes / No`) read consistently across the wheel.
- **Two label orientations** — *tangent* (text wraps around the rim, arched per-glyph along the segment arc) and *radial* (text reads along the spoke from rim to centre).
- **Theme-aware indicator + hub** — pointer triangle and centre hub use HA's `--primary-color`. Hub label auto-picks black or white text via WCAG relative luminance, so it stays readable against any theme accent.
- **Peg-click sound** — synthesised in the browser via Web Audio (no asset file). Each segment crossing fires a softened click; volume follows a bell-curve (peaks around 12 rad/s, tapers at high speed) and rate-limits at ~33 Hz so a fast spin doesn't pile into a noisy wash. Stops automatically when the wheel rests. Toggle off in config.
- **Responsive canvas** — `ResizeObserver`-driven, scales 140–600 px to fill whatever grid cell the dashboard gives it. High-DPI aware.
- **Translatable** — English and German bundled, falls back to English for any other HA language. UI strings, validation errors, default card title, and default hub text all translate.
- **Keyboard support** — focus the wheel, press `Space` or `Enter` to spin. Same impulse / boost behaviour as a pointer click.
- **Honours `prefers-reduced-motion`** — the multi-second decay is skipped at the physics layer for users who have asked the OS to reduce motion. The wheel still spins (the spin *is* the feature) but only an instant snap to the result; no per-frame animation, no audio.
- **No runtime dependencies beyond `lit`** (~15 KB gzipped). Rollup-bundled into a single `dist/spinning-wheel-card.js` (~50 KB unminified, ~17 KB gzipped).

## Installation

### HACS (recommended)

1. HACS → **Frontend** → ⋯ → **Custom repositories**.
2. Add `https://github.com/rolandzeiner/spinning-wheel-card` as type **Lovelace**.
3. Search for "Spinning Wheel Card" and install.
4. Hard-refresh the browser (⌘⇧R / Ctrl⇧R) so the new bundle loads.

[![Add to HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=rolandzeiner&repository=spinning-wheel-card&category=plugin)

### Manual

1. Download `spinning-wheel-card.js` from the [latest release](https://github.com/rolandzeiner/spinning-wheel-card/releases).
2. Copy it to `<config>/www/community/spinning-wheel-card/spinning-wheel-card.js`.
3. **Settings → Dashboards → Resources → Add resource**:
   - URL: `/local/community/spinning-wheel-card/spinning-wheel-card.js`
   - Type: **JavaScript module**
4. Hard-refresh the browser.

## Quick start

```yaml
type: custom:spinning-wheel-card
```

That's it — defaults: 8 numeric segments, medium friction, sound on, tangent labels, "SPIN" centre, English (or German if your HA locale is `de*`).

## Configuration reference

All options are optional. Use the visual editor (Add Card → Spinning Wheel Card → ⚙) for a guided form, or write YAML directly.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | localised "Spinning Wheel" | Card header text. |
| `segments` | integer 4–24 | `8` | How many slices the wheel is divided into. |
| `friction` | `low` / `medium` / `high` | `medium` | Deceleration preset — see [Friction presets](#friction-presets). |
| `labels` | string[] (1..segments) | `1` … `N` | Per-segment labels. **Shorter arrays cycle** around the wheel — `[Yes, No]` on 8 segments → `Yes No Yes No Yes No Yes No`. |
| `weights` | number[] (1..segments) | all equal | Relative segment widths (only the ratio matters). Same cycling rule as `labels` — `[3, 1]` on 4 segments → big, small, big, small. |
| `colors` | string[] (1..segments) | built-in 8-colour palette | CSS colours (hex, `rgb()`, `hsl()`, `var(--…)`, named). Mapped to **unique labels in order of first appearance** — segments sharing a label always share a colour. |
| `label_colors` | string[] (1..segments) | dark grey | CSS colours for the segment label text. Same unique-label mapping as `colors`. |
| `text_orientation` | `tangent` / `radial` | `tangent` | Tangent wraps each label around the rim, glyph-by-glyph along the segment arc. Radial rotates 90° CW so text reads along the spoke from rim to centre. |
| `hub_text` | string | localised "SPIN" / "DREH" | Centre-hub label. Auto-shrinks for long strings. Empty string hides it. |
| `sound` | boolean | `true` | Peg-click sound on segment crossings. |

### Friction presets

| Preset   | Per-frame multiplier @ 60 fps | Roughly stops after |
| -------- | -------------------- | ------------------- |
| `low`    | 0.995                | ~6 s                |
| `medium` | 0.99 (default)       | ~4 s                |
| `high`   | 0.98                 | ~2 s                |

Decay is frame-rate independent — `ω *= friction^(60·dt)` — so the wall-clock stop time is the same at 30 / 60 / 120 fps.

## Examples

**Yes / No wheel** — labels cycle around 8 segments; colours pair to labels:

```yaml
type: custom:spinning-wheel-card
name: Decision Maker
segments: 8
labels: [Yes, No]
colors: ["#06d6a0", "#e63946"]   # all Yes green, all No red
hub_text: GO
```

**Weighted wheel** — one big "Jackpot" slice, three small "Try again":

```yaml
type: custom:spinning-wheel-card
segments: 4
weights: [2, 1, 1, 1]
labels: [Jackpot, Try Again, Try Again, Try Again]
colors: ["#f4a261", "#a8dadc", "#a8dadc", "#a8dadc"]
```

**Food picker** — fully labelled 8-segment with custom palette:

```yaml
type: custom:spinning-wheel-card
name: What's for dinner?
segments: 8
labels: [Pizza, Sushi, Tacos, Burgers, Pasta, Salad, Curry, Sandwich]
text_orientation: radial   # easier to read along the spoke when labels are wordy
```

**Theme-coloured wheel** — borrow accents straight from the user's HA theme:

```yaml
type: custom:spinning-wheel-card
labels: [On, Off]
colors:
  - "var(--success-color)"
  - "var(--error-color)"
hub_text: ""               # hide the centre label
```

**Silent wheel** — for always-on dashboards in shared rooms:

```yaml
type: custom:spinning-wheel-card
sound: false
```

## Controls

| Action | What it does |
| --- | --- |
| Click while wheel is at rest | Random impulse spin (random direction). |
| Click while spinning | **Boost** — adds an impulse in the wheel's current direction, capped at MAX_VELOCITY. |
| Click + drag | Wheel follows cursor while held; releases with the angular velocity sampled over the last 100 ms. |
| Drag past ~3 px before releasing | Treated as a drag (commandeers the wheel). Below that — including pointer jitter during a click — stays a click. |
| Tab to focus, then `Space` / `Enter` | Keyboard equivalent of a click — same impulse-or-boost behaviour. |

## Translations

Bundled languages: **English (en)** and **German (de)**. The active language follows `hass.locale.language` (HA profile) and falls back through `hass.language` → `navigator.language` → `en`. Switching language in HA re-renders the card live; no reload needed.

Adding a third language is mechanical:

1. Drop a `<code>.json` next to `src/localize/languages/{en,de}.json` with the same key tree.
2. Register it in `src/localize/localize.ts`:
   ```ts
   import * as fr from "./languages/fr.json";
   const languages = { en, de, fr };
   ```
3. `npm run build`. PRs welcome.

Missing keys fall through to English, so a partial translation is still useful.

## Accessibility

- Hub label automatically picks black or white text using WCAG relative-luminance against the active `--primary-color`, so it reads against any theme accent.
- Pointer triangle uses the same accent — visually unifies as one "spin mechanism".
- **`prefers-reduced-motion: reduce`** is honoured at the physics layer — when the user has expressed motion sensitivity the multi-second decay animation is skipped, the wheel snaps to its final resting angle, and the result is announced immediately. WCAG 2.3.3.
- **Forced-colors mode** (Windows High Contrast): the focus ring uses the system `CanvasText` colour so it remains visible.
- **Keyboard equivalents**: the canvas takes `tabindex="0"` and accepts `Space` / `Enter` to trigger the same impulse-or-boost behaviour as a pointer click. Drag-to-throw still requires pointer input, since there's no clean keyboard mapping for analogue release velocity. Focus ring is styled (`:focus-visible`).

## Browser support

Modern evergreen browsers — Chrome / Edge / Firefox / Safari current major + previous. The card uses `Web Audio`, `ResizeObserver`, `Pointer Events`, ES2022 syntax. No IE11.

## Build from source

```bash
git clone https://github.com/rolandzeiner/spinning-wheel-card.git
cd spinning-wheel-card
npm install
npm run build           # → dist/spinning-wheel-card.js
npm run dev             # rollup watch mode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the verification gate and PR conventions.

## License

[MIT](LICENSE) © Roland Zeiner.
