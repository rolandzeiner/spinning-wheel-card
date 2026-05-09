import * as en from "./languages/en.json";
import * as de from "./languages/de.json";
import * as fr from "./languages/fr.json";
import * as it from "./languages/it.json";
import * as es from "./languages/es.json";
import * as pt from "./languages/pt.json";
import * as zh from "./languages/zh.json";
import * as ja from "./languages/ja.json";

// English is the canonical fallback. Any HA language outside this map
// resolves through English, and any missing key in a partially-translated
// language also falls back to English before returning the raw key.
const languages: Record<string, Record<string, unknown>> = {
  en,
  de,
  fr,
  it,
  es,
  pt,
  zh,
  ja,
};

function resolveTranslation(
  path: string,
  dictionary: Record<string, unknown>,
): string | undefined {
  const value = path.split(".").reduce<unknown>((acc, key) => {
    if (
      acc &&
      typeof acc === "object" &&
      key in (acc as Record<string, unknown>)
    ) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, dictionary);
  return typeof value === "string" ? value : undefined;
}

/**
 * Translate a dot-path key. Pass `hass.locale?.language` (or
 * `navigator.language` for module-init contexts that run before hass is
 * available, e.g. `window.customCards.push`) as `lang` so the helper
 * picks up language changes without a page reload.
 *
 * Optional `vars` does `{name}` substitution in the resolved string —
 * useful for parameterised messages like `Result: {value}`.
 */
export function localize(
  key: string,
  lang: string | undefined = undefined,
  vars?: Record<string, string | number>,
): string {
  // Strip BCP-47 region — HA uses 'en-GB', 'de-AT'; our dicts are
  // ISO-639-1 lowercase ('en', 'de').
  const code = (lang ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";

  // noUncheckedIndexedAccess narrows languages[k] to Record | undefined;
  // coerce to the always-present `en` fallback at each lookup.
  const dict = languages[code] ?? languages.en ?? {};
  const enDict = languages.en ?? {};
  let translated = resolveTranslation(key, dict);
  if (translated === undefined) translated = resolveTranslation(key, enDict);
  if (translated === undefined) translated = key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      translated = translated.replace(
        new RegExp(`\\{${k}\\}`, "g"),
        String(v),
      );
    }
  }
  return translated;
}

/**
 * Resolve the active UI language from a `hass` object, falling through
 * `hass.locale.language` → `hass.language` (legacy) → `navigator.language`
 * → `"en"`. Centralises the chain previously duplicated in the card
 * and editor.
 */
export function resolveLang(
  hass:
    | { locale?: { language?: string }; language?: string }
    | undefined
    | null,
): string {
  return (
    hass?.locale?.language ??
    hass?.language ??
    (typeof navigator !== "undefined" ? navigator.language : "en")
  );
}
