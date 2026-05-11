import * as en from "./languages/en.json";
import * as de from "./languages/de.json";
import * as fr from "./languages/fr.json";
import * as it from "./languages/it.json";
import * as es from "./languages/es.json";
import * as pt from "./languages/pt.json";
import * as nl from "./languages/nl.json";
import * as zh from "./languages/zh.json";
import * as ja from "./languages/ja.json";

// English is the canonical fallback for missing dicts and missing keys.
const languages: Record<string, Record<string, unknown>> = {
  en,
  de,
  fr,
  it,
  es,
  pt,
  nl,
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

/** Translate a dot-path key. Pass `hass.locale?.language` (or
 *  `navigator.language` at module-init time, before hass is available)
 *  as `lang`. Optional `vars` does `{name}` substitution. */
export function localize(
  key: string,
  lang: string | undefined = undefined,
  vars?: Record<string, string | number>,
): string {
  // Strip BCP-47 region — dicts are ISO-639-1 lowercase.
  const code = (lang ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";

  const dict = languages[code] ?? languages.en ?? {};
  const enDict = languages.en ?? {};
  let translated = resolveTranslation(key, dict);
  if (translated === undefined) translated = resolveTranslation(key, enDict);
  if (translated === undefined) translated = key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      // Function form so `$&`/`$1`/`$<name>` in the substitution value
      // are NOT interpreted as replacement patterns — a todo summary
      // like "Pay $50 to $&" must render literally, not as the matched
      // `{value}` placeholder.
      const replacement = String(v);
      translated = translated.replace(
        new RegExp(`\\{${k}\\}`, "g"),
        () => replacement,
      );
    }
  }
  return translated;
}

/** Resolve UI language: `hass.locale.language` → `hass.language` →
 *  `navigator.language` → `"en"`. */
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
