import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // happy-dom provides `window`, `navigator`, etc. — the card module
    // imports Lit and references `window.customCards` at top level, so
    // a Node-only env can't even load the file. happy-dom boots in
    // <50 ms and is enough for our pure-function tests.
    environment: "happy-dom",
  },
});
