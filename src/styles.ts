import { css } from "lit";

export const editorStyles = css`
  :host {
    color-scheme: light dark;
    display: block;
  }
  .editor {
    padding: var(--ha-space-4, 16px);
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-3, 12px);
  }
  .editor-section {
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
    border-radius: var(--ha-border-radius-lg, 12px);
    padding: var(--ha-space-3, 14px) var(--ha-space-4, 16px);
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-2, 10px);
  }
  .section-header {
    font-size: var(--ha-font-size-xs, 11px);
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--secondary-text-color);
  }
  .editor-hint {
    font-size: var(--ha-font-size-s, 12px);
    color: var(--secondary-text-color);
    line-height: 1.4;
  }

  /* Native <button> rather than <mwc-button> — mwc-* is being phased
     out of HA's frontend (ha-lovelace-card SKILL.md). */
  .result-entity-row {
    display: block;
    margin-top: var(--ha-space-2, 8px);
  }
  .create-helper-row {
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-2, 8px);
    align-items: flex-end;
  }
  .create-helper-hint {
    margin: 0;
    width: 100%;
    font-size: var(--ha-font-size-s, 12px);
    line-height: 1.4;
    color: var(--secondary-text-color);
  }
  .create-helper-btn {
    appearance: none;
    cursor: pointer;
    background: var(--primary-color);
    color: var(--text-primary-color, #fff);
    border: 0;
    border-radius: var(--ha-border-radius-md, 8px);
    padding: var(--ha-space-2, 8px) var(--ha-space-3, 12px);
    font-size: var(--ha-font-size-s, 12px);
    font-weight: 500;
    line-height: 1.2;
    transition:
      background-color 0.16s ease,
      transform 0.08s ease;
  }
  .create-helper-btn:hover {
    background: color-mix(
      in srgb,
      var(--primary-color) 88%,
      black
    );
  }
  .create-helper-btn:active {
    transform: translateY(1px);
  }
  .create-helper-btn:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  /* Custom labels widget — text + icon-picker chip composer. Lives
     outside ha-form so a single chip list can mix free-typed labels
     with MDI icons and preview the icons inline. */
  .labels-section {
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-2, 8px);
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
    border-radius: var(--ha-border-radius-lg, 12px);
    padding: var(--ha-space-3, 14px) var(--ha-space-4, 16px);
  }
  .labels-section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--ha-space-2, 8px);
  }
  .labels-section-label {
    font-size: var(--ha-font-size-m, 14px);
    font-weight: 500;
    color: var(--primary-text-color);
  }
  .labels-section-count {
    font-size: var(--ha-font-size-s, 12px);
    color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums;
  }
  .labels-helper {
    font-size: var(--ha-font-size-s, 12px);
    color: var(--secondary-text-color);
    line-height: 1.4;
  }
  .labels-empty {
    font-size: var(--ha-font-size-s, 12px);
    color: var(--secondary-text-color);
    font-style: italic;
    padding: var(--ha-space-2, 8px) 0;
  }
  .labels-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .label-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 4px 4px 10px;
    min-height: 32px;
    background: color-mix(in srgb, var(--primary-color) 16%, transparent);
    color: var(--primary-text-color);
    border-radius: 16px;
    font-size: 0.8125rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .label-chip-icon {
    background: color-mix(in srgb, var(--primary-color) 22%, transparent);
  }
  .label-chip ha-icon {
    --mdc-icon-size: 18px;
    color: var(--primary-color);
  }
  .label-chip-tag {
    font-size: 0.75rem;
    color: var(--secondary-text-color);
    font-family: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;
  }
  .label-chip-text {
    white-space: nowrap;
  }
  .label-chip-remove {
    appearance: none;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }
  .label-chip-remove:hover {
    background: rgba(0, 0, 0, 0.18);
  }
  .label-chip-remove:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }
  .labels-add-stack {
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-2, 8px);
  }
  .labels-add-text,
  .labels-add-icon {
    width: 100%;
  }
  /* Divider between primary (text) and secondary (icon picker) inputs.
     Reads "or pick an icon ↓" so users see the text input as the
     default path; icon picker is the labelled side path below. */
  .labels-add-divider {
    display: flex;
    align-items: center;
    gap: var(--ha-space-2, 8px);
    font-size: var(--ha-font-size-xs, 11px);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--secondary-text-color);
    margin-top: var(--ha-space-1, 4px);
  }
  .labels-add-divider::before,
  .labels-add-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--divider-color, rgba(0, 0, 0, 0.12));
  }

  a:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    a:focus-visible,
    button:focus-visible {
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
