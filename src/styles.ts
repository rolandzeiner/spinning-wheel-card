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
