import { css } from "lit";

/* The editor is laid out by Home Assistant's own pieces — ha-form,
   ha-expansion-panel, ha-button — and these rules only space them and draw
   the segment rows and colour swatches. Nothing here sets a colour the
   theme doesn't already own. */
export const editorStyles = css`
  :host {
    color-scheme: light dark;
    display: block;
  }

  .ed {
    display: grid;
    gap: 16px;
  }

  .ed-groups {
    display: grid;
    gap: 8px;
  }

  .ed-body {
    display: grid;
    gap: 12px;
    padding: 4px 0 8px;
  }

  .ed-heading {
    margin: 4px 0 0;
    font-size: var(--ha-font-size-l, 16px);
    font-weight: var(--ha-font-weight-medium, 500);
  }

  .ed-segments {
    display: grid;
    gap: 12px;
  }

  .ed-hint {
    margin: 0;
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
    line-height: 1.45;
  }

  .ed-note {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--ha-border-radius-md, 8px);
    background: var(--secondary-background-color);
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
    line-height: 1.45;
  }

  .ed-empty {
    margin: 0;
    padding: 16px;
    border: 1px dashed var(--divider-color);
    border-radius: var(--ha-border-radius-md, 8px);
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
  }

  /* Rarer options sit below this in the same group, not behind a click. */
  .ed-divider {
    width: 100%;
    margin: 2px 0;
    border: 0;
    border-top: 1px solid var(--divider-color);
  }

  .ed-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .ed-result {
    display: grid;
    gap: 4px;
  }

  /* The segments as one list in one outline, rows divided by a rule: the
     shape of HA's own entity lists, quieter than a box per row. */
  .ed-rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--divider-color);
    border-radius: var(--ha-border-radius-md, 8px);
    overflow: hidden;
  }

  .ed-row + .ed-row {
    border-top: 1px solid var(--divider-color);
  }

  .ed-row-head {
    display: flex;
    align-items: center;
    padding-inline-end: 4px;
    color: var(--secondary-text-color);
  }

  /* The whole name area opens the row: a big target, a real button. */
  .ed-row-main {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 56px;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 8px 12px;
    border: 0;
    background: none;
    color: var(--primary-text-color);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .ed-row-main:hover {
    background: color-mix(in srgb, var(--primary-color) 6%, transparent);
  }

  .ed-row-main:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: -2px;
  }

  .ed-row-titles {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .ed-row-name {
    font-weight: var(--ha-font-weight-medium, 500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ed-row-summary {
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ed-chevron {
    flex: none;
    color: var(--secondary-text-color);
  }

  .ed-row.open .ed-chevron {
    transform: rotate(180deg);
  }

  .ed-row-body {
    display: grid;
    gap: 12px;
    padding: 4px 12px 12px;
    border-top: 1px solid var(--divider-color);
    background: color-mix(in srgb, var(--primary-text-color) 3%, transparent);
  }

  /* The segment's fill, with "Aa" in its text colour: the row shows what
     the wheel paints. */
  .ed-dot {
    display: grid;
    flex: none;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px var(--divider-color);
    font-size: 11px;
    font-weight: 700;
  }

  .ed-colours {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }

  .ed-color {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  .swatch {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
  }

  .swatch input[type="color"] {
    width: 44px;
    height: 44px;
    padding: 0;
    border: 1px solid var(--divider-color);
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }

  .swatch input[type="color"]::-webkit-color-swatch-wrapper {
    padding: 4px;
  }

  .swatch input[type="color"]::-webkit-color-swatch {
    border: 0;
    border-radius: 50%;
  }

  .swatch input[type="color"]::-moz-color-swatch {
    border: 0;
    border-radius: 50%;
  }

  .swatch input[type="color"]:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }

  .ed-color-text {
    display: grid;
    gap: 2px;
  }

  .ed-fallback {
    display: grid;
    gap: 8px;
  }

  @media (forced-colors: active) {
    .ed-row-main:focus-visible,
    .swatch input[type="color"]:focus-visible {
      outline-color: CanvasText;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;
