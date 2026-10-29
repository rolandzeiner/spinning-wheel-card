# <sub><sub><img src="https://raw.githubusercontent.com/rolandzeiner/spinning-wheel-card/main/brand/icon.png" width="40" height="40" alt=""></sub></sub> Spinning Wheel Card

[![Marketplace](https://img.shields.io/badge/Marketplace-Catalog-41BDF5.svg)](https://www.home-assistant.io/integrations/marketplace/)
[![Version](https://img.shields.io/github/v/release/rolandzeiner/spinning-wheel-card?label=version&color=blue)](https://github.com/rolandzeiner/spinning-wheel-card/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![vibe-coded](https://img.shields.io/badge/vibe-coded-ff69b4?logo=musicbrainz&logoColor=white)](https://en.wikipedia.org/wiki/Vibe_coding)

A prize wheel for your Home Assistant dashboard: click to spin it or drag to throw it, and let the winning segment run an action, set a light or fill a helper. The card runs entirely in your browser, with nothing to set up on the Home Assistant side.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/rolandzeiner/spinning-wheel-card/main/screenshots/card.webp" height="420" alt="Spinning wheel card" /></td>
    <td align="center"><img src="https://raw.githubusercontent.com/rolandzeiner/spinning-wheel-card/main/screenshots/card-config.webp" height="420" alt="Visual card editor" /></td>
  </tr>
  <tr>
    <td align="center"><em>Lovelace card</em></td>
    <td align="center"><em>Visual editor</em></td>
  </tr>
</table>

## Features

- Click to spin or drag to throw, with momentum and friction that feel physical. One slider sets how long a spin lasts.
- 4 to 24 segments with their own labels or MDI icons, sizes, fill and text colours, plus four built-in palettes.
- A half-circle layout for narrow cells, and a pick mode where you drag a segment to the pointer instead of spinning.
- Optional pegs on the rim that click and brake the wheel, with six synthesised click sounds to choose from.
- The winning segment can run an action, write its label to a text helper, or come from your to-do list.
- Lights can take the winning colour and speakers can announce the result, without writing a script.
- A visual editor for every option, in English, German, French, Italian, Spanish, Portuguese, Dutch, Chinese and Japanese.
- Keyboard control, screen-reader announcements, reduced motion and high-contrast support, built to WCAG 2.2 AA.

## Installation

### Marketplace (recommended)

The Marketplace is HACS, built into Home Assistant since 2026.11.

1. In Home Assistant, go to **Settings → Marketplace** and search for **Spinning Wheel Card**.
2. Select it, then select **Install**. Then reload your browser.

[![Open this repository in the Marketplace of your Home Assistant.](https://my.home-assistant.io/badges/marketplace_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=rolandzeiner&repository=spinning-wheel-card&category=plugin)

On Home Assistant older than 2026.11, use HACS instead: search for **Spinning Wheel Card**, select **Download**, then reload the browser.

### Manual

1. Download `spinning-wheel-card.js` from the [latest release](https://github.com/rolandzeiner/spinning-wheel-card/releases/latest).
2. Copy it to `<config>/www/community/spinning-wheel-card/`.
3. Go to **Settings → Dashboards**, then ⋮ → **Resources**, and add `/local/community/spinning-wheel-card/spinning-wheel-card.js` with type **JavaScript module**.
4. Reload your browser.

## Configuration

Every option is optional. In a dashboard, select **Add card** and pick **Spinning Wheel** to use the visual editor, or write YAML.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | none | Header text. Empty hides the header. |
| `language` | language code | auto | Overrides the language Home Assistant uses. Unsupported codes fall back to English. |
| `segments` | integer 4–24 | `8` | Number of segments. Ignored while `todo_entity` is set. |
| `friction` | integer 1–10 | `5` | How fast the wheel slows down: `1` spins long, `10` stops quickly. Also sets how hard each peg brakes. The strings `low`, `medium` and `high` still work and mean `3`, `5` and `7`. See *Friction*. |
| `theme` | `default` / `pastel` / `pride` / `neon` | `default` | Palette for segments without their own fill colour. See *Theme presets*. |
| `labels` | list of strings | `1` … `N` | Segment labels. A shorter list repeats. `mdi:icon-name` draws an icon. Ignored while `todo_entity` is set. |
| `weights` | list of numbers | all equal | Relative segment sizes. A segment with weight `2` is twice as large, and twice as likely, as one with `1`. A shorter list repeats. |
| `colors` | list of CSS colours | from `theme` | Fill colours (hex, `rgb()`, `hsl()`, `var(--…)` or a colour name), one per unique label in the order the labels first appear. `null` leaves a segment to the theme. |
| `label_colors` | list of CSS colours | auto | Text colours, matched to labels like `colors`. Unset, each label is black or white, whichever contrasts more with its fill. |
| `actions` | list | none | What runs when a segment wins, matched to labels like `colors`: a `script.<name>` shorthand, a Lovelace [action](https://www.home-assistant.io/dashboards/actions/) object, or `null` for nothing. |
| `disable_confirm_actions` | boolean | `false` | Runs actions without asking first. `confirmation: false` on a single action skips the prompt for that action only. |
| `wheel_context` | boolean | `false` | Adds the winning segment to the `data` of every `perform-action` and `call-service` action as `wheel_index`, `wheel_label`, `wheel_color`, `wheel_color_rgb`, `wheel_label_color` and `wheel_label_color_rgb`. Keys you set in `data` take precedence. |
| `disable_boost` | boolean | `false` | Ignores clicks, **Space** and **Enter** while the wheel turns. Dragging still works. |
| `half_circle` | boolean | `false` | Shows only the upper half, with the hub on the cut edge, so the card gets shorter. |
| `selector_mode` | boolean | `false` | Pick mode: no spinning. Drag a segment to the pointer and let go to run its action. The hub shows no text. |
| `segment_borders` | boolean | `true` | Thin white lines between segments. Turn them off for a flat look. |
| `pegs` | boolean | `false` | Pegs on the rim. Each one clicks and brakes the wheel slightly as it passes the pointer. A wheel that stops on a peg settles off it. |
| `peg_density` | integer 0–4 | `1` | Extra pegs per segment, on top of the one at each segment boundary: `0` gives one peg per segment, `4` gives five. Needs `pegs`. |
| `result_entity` | `input_text` entity | none | Text helper that gets the winning label after every spin. In the editor, an admin can create one with **Create helper**. |
| `light_sync_entities` | list of `light` entities | none | Lights set to the winning segment's fill colour after every spin, through `light.turn_on` with `rgb_color`. Works without `actions`. |
| `tts_engine` | `tts` entity | none | Text-to-speech engine that speaks the winning label. Needs `tts_announce_entities`. |
| `tts_announce_entities` | list of `media_player` entities | none | Speakers that announce the winning label after every spin, through `tts.speak`. Icon labels are read without `mdi:` and with hyphens as spaces, so `mdi:food-croissant` becomes "food croissant". |
| `todo_entity` | `todo` entity | none | Fills the segments from the open items of this to-do list. `segments` and `labels` are ignored while it is set. |
| `text_orientation` | `tangent` / `radial` | `tangent` (`radial` with `todo_entity`) | `tangent` runs labels along the rim, `radial` along the spoke. |
| `label_auto_fit` | boolean | `false` | Shrinks long labels to fit their segment, down to 7 px, then shortens them with an ellipsis. Off, labels keep the size from `label_font_scale` and are cut short. Always on with `todo_entity`. |
| `label_font_scale` | integer 70–150 | `100` | Label size in percent, icon labels included. With `label_auto_fit` it is the largest size. |
| `label_radius_offset` | integer -20–20 | `0` | Moves labels toward the hub (negative) or the rim (positive), in percent of the radius, from 66 % (55 % for radial labels with `todo_entity`). Labels never overlap the hub or leave the wheel. |
| `label_flip` | boolean | `false` | Reverses the reading direction. Radial labels then read from the hub outward. Tangent labels turn their tops toward the centre, which reads better when results land at the bottom of the wheel. |
| `hub_text` | string | `SPIN` (localised) | Hub label. It shrinks to fit, and an empty string hides it. |
| `hub_color` | `theme` / `black` / `white` | `theme` | Fill of the hub and pointer. `theme` uses your theme's primary colour. The hub text is black or white, whichever contrasts more. |
| `sound` | boolean | `true` | A click each time a segment boundary passes the pointer, or each peg when `pegs` is on. |
| `click_sound` | `classic` / `wood` / `flapper` / `pin` / `felt` / `ratchet` | `classic` | How each click sounds: `classic` a short, light click, `wood` a warm knock, `flapper` a rubber flap that springs back on slow crossings, `pin` a bright metal tink, `felt` a muted thud, `ratchet` a crisp, dry tick. Faster crossings click harder and shorter. The editor plays a sample when you pick one. |
| `show_status` | boolean | `true` | The line under the wheel: **Spinning…**, the result, or a hint. When hidden, screen readers still hear it. |

The smallest configuration:

```yaml
type: custom:spinning-wheel-card
```

That gives 8 numbered segments, friction 5, sound on, labels along the rim and the language of your Home Assistant.

### Friction

| `friction` | Stops after a click | With pegs |
| --- | --- | --- |
| `1` | about 27 s | about 22 s |
| `3` | about 9 s | about 7 s |
| `5` | about 5 s | about 4 s |
| `7` | about 3 s | about 2.6 s |
| `10` | about 2 s | about 1.7 s |

The times are for a click of middle strength on 8 segments, with pegs at the default two per segment. A harder throw spins longer, and more pegs stop the wheel sooner. The editor shows the time under the slider.

### Theme presets

| Preset | Palette |
| --- | --- |
| `default` | 8-colour rainbow. |
| `pastel` | 8 soft, low-saturation tones. |
| `pride` | 10 inclusive Pride colours: the 6-stripe rainbow, the transgender stripes and bisexual purple. |
| `neon` | 8 vivid, fully saturated tones. |

With more distinct labels than colours, the palette repeats. Your own `colors` always take precedence over `theme`.

### Controls

| Input | What happens |
| --- | --- |
| Click at rest | Spins the wheel in a random direction. |
| Click while spinning | Adds speed in the current direction. |
| Drag | The wheel follows the pointer. Let go to throw it at the speed you dragged. |
| **Space** or **Enter** (wheel focused) | Same as a click. In pick mode, runs the current segment again. |
| **←** or **→** (wheel focused, pick mode) | Moves the selection one segment. |

With reduced motion turned on in your system, the wheel skips the spin animation and jumps straight to the result.

### Language

The card follows your Home Assistant language, then your browser's, then English. Region codes such as `de-AT` use the base language. Set `language` to fix one per card.

## Examples

**Yes or no**, with the two labels repeating around the wheel:

```yaml
type: custom:spinning-wheel-card
labels: [Yes, No]
colors: ["#06d6a0", "#e63946"]
hub_text: GO
```

**Weighted wheel**, one large segment and three small ones:

```yaml
type: custom:spinning-wheel-card
segments: 4
weights: [2, 1, 1, 1]
labels: [Jackpot, Try Again, Try Again, Try Again]
```

**Icons as labels:**

```yaml
type: custom:spinning-wheel-card
segments: 6
labels: [mdi:pizza, mdi:hamburger, mdi:noodles, mdi:taco, mdi:food-croissant, mdi:silverware-fork-knife]
hub_text: ""
```

<details>
<summary>Long labels: 20 amino acids that shrink to fit along the spoke</summary>

```yaml
type: custom:spinning-wheel-card
segments: 20
text_orientation: radial
label_auto_fit: true
label_radius_offset: 10   # labels closer to the rim, for more room along the spoke
labels:
  - Alanine
  - Arginine
  - Asparagine
  - Aspartic acid
  - Cysteine
  - Glutamic acid
  - Glutamine
  - Glycine
  - Histidine
  - Isoleucine
  - Leucine
  - Lysine
  - Methionine
  - Phenylalanine
  - Proline
  - Serine
  - Threonine
  - Tryptophan
  - Tyrosine
  - Valine
```

</details>

**A script per winner:**

```yaml
type: custom:spinning-wheel-card
labels: [Pizza, Burgers, Sushi]
actions: [script.order_pizza, script.order_burgers, script.order_sushi]
```

**Result helper**, so an automation can react to the winning label:

```yaml
type: custom:spinning-wheel-card
labels: [Bedtime, Movie, Game night]
result_entity: input_text.spinning_wheel_result
```

```yaml
- alias: Wheel result router
  triggers:
    - trigger: state
      entity_id: input_text.spinning_wheel_result
  actions:
    - action: scene.turn_on
      target:
        entity_id: "scene.{{ trigger.to_state.state | lower | replace(' ', '_') }}"
```

**To-do list wheel**, with the open items as segments:

```yaml
type: custom:spinning-wheel-card
todo_entity: todo.shopping_list
hub_text: ""
```

**Half circle:**

```yaml
type: custom:spinning-wheel-card
half_circle: true
labels: [Easy, Medium, Hard]
```

**Pick mode**, choosing a room by hand:

```yaml
type: custom:spinning-wheel-card
selector_mode: true
labels: [Living room, Kitchen, Bedroom]
actions: [script.lights_living, script.lights_kitchen, script.lights_bedroom]
```

**One script for every segment.** With `wheel_context`, the script receives the winning segment as variables. A single entry in `actions` repeats for every label.

```yaml
type: custom:spinning-wheel-card
labels: [Red, Green, Blue]
colors: ["#e40303", "#008026", "#004dff"]
wheel_context: true
actions: [script.set_light_colour]
```

```yaml
# script.set_light_colour
sequence:
  - action: light.turn_on
    target:
      entity_id: light.living_room
    data:
      rgb_color: "{{ wheel_color_rgb }}"
```

**The same without a script**, using `light_sync_entities`:

```yaml
type: custom:spinning-wheel-card
labels: [Red, Green, Blue]
colors: ["#e40303", "#008026", "#004dff"]
light_sync_entities:
  - light.living_room
  - light.bed_strip
```

**Spoken result** on a smart speaker:

```yaml
type: custom:spinning-wheel-card
labels: [Pizza, Burgers, Sushi]
tts_engine: tts.home_assistant_cloud
tts_announce_entities:
  - media_player.kitchen_speaker
```

**Prize wheel** with a densely studded rim:

```yaml
type: custom:spinning-wheel-card
pegs: true
peg_density: 3       # 4 pegs per segment: 1 at the boundary, 3 in between
segment_borders: false
theme: pride
labels: [mdi:pizza, mdi:hamburger, mdi:noodles, mdi:taco, mdi:food-croissant, mdi:silverware-fork-knife]
```

## Known limitations

- A spin happens in the browser that started it. Other open dashboards don't see it. Use `result_entity` to share the result.
- The to-do wheel shows at most 24 open items. Items with the same text become one segment, and fewer than 4 items repeat to fill the wheel.
- Light sync only changes bulbs that support colour (RGB, RGBW, RGBWW, HS or XY). Lights with only colour temperature or brightness are skipped, and so is a segment whose colour is a `var(--…)` theme variable.
- The text-to-speech engine pronounces the label in its own configured language, not the card's.
- The prompt before an action is your browser's own confirmation dialog.
- Only an admin can create the result helper from the editor.

## Troubleshooting

**The card shows an error instead of the wheel.** The message names the first option with a value the card can't use. Fix that value, and the next one shows if there is another.

**After an update, the old card still shows.** Reload the browser without the cache (⌘⇧R on a Mac, Ctrl+Shift+R elsewhere). For a manual install, also delete `spinning-wheel-card.js.gz` next to the card file if there is one: Home Assistant serves that compressed copy in preference to the new file.

## Removal

1. Remove the card from your dashboards.
2. In **Settings → Marketplace**, open **Spinning Wheel Card**, then ⋮ → **Uninstall**.
3. Reload your browser.

For a manual install, delete `<config>/www/community/spinning-wheel-card/` and remove its entry under **Settings → Dashboards**, then ⋮ → **Resources**. A helper you created with **Create helper** stays; delete it under **Settings → Devices & services → Helpers** if you no longer need it.

## Attribution

The card bundle includes [Lit](https://lit.dev/), © Google LLC, under the BSD 3-Clause licence.

## License

MIT. See [LICENSE](https://github.com/rolandzeiner/spinning-wheel-card/blob/main/LICENSE).

To build the card or contribute, see [CONTRIBUTING.md](https://github.com/rolandzeiner/spinning-wheel-card/blob/main/CONTRIBUTING.md).

## Disclaimer

This card is provided as is, without warranty of any kind. It is not affiliated with or endorsed by Home Assistant or the Open Home Foundation. Use at your own risk.

---

Diese Karte wird ohne jede Gewährleistung bereitgestellt. Sie steht in keiner Verbindung zu Home Assistant oder der Open Home Foundation und wird von diesen nicht unterstützt. Nutzung auf eigene Verantwortung.
