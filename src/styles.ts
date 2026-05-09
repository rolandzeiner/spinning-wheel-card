import { css } from "lit";

// Editor-side styles. Live in the editor's shadow root.
// HA form components (ha-textfield, ha-switch, etc.) bring their own
// theming — keep editor CSS to layout + spacing.
//
// `<ha-form>` owns its own focus rings, but custom widgets inside the
// editor (chips, picker buttons, ...) need the same a11y catch-all the
// card carries. Ship the three blocks here too.
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
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  /* ── Accessibility primitives ───────────────────────────────────── */
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
