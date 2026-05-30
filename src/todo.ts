import type { HomeAssistant, TodoItem } from "./types";

/** Dedup an item list by non-empty `summary`, preserving first-seen
 *  order. The same-label-same-colour rule would otherwise collapse two
 *  identically-named items into one visual segment, so equal summaries
 *  are folded to a single slot here. */
export const uniqueTodoItems = (
  items: ReadonlyArray<TodoItem>,
): TodoItem[] => {
  const seen = new Set<string>();
  const out: TodoItem[] = [];
  for (const item of items) {
    const key = item.summary ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

/** Fetch open (`needs_action`) todo items for `entity` via the
 *  `todo/item/list` WebSocket command, filtered and deduped by summary.
 *  Returns `null` when no WS transport is available (caller decides
 *  whether that's a no-op or an error). Throws on WS failure so the
 *  caller can log with its own context prefix. Card and editor both
 *  call this so they agree on which items become unique-label slots. */
export const fetchOpenTodoItems = async (
  hass: HomeAssistant,
  entity: string,
): Promise<TodoItem[] | null> => {
  if (!hass.callWS) return null;
  const reply = (await hass.callWS({
    type: "todo/item/list",
    entity_id: entity,
  })) as { items?: ReadonlyArray<TodoItem> } | undefined;
  const all = reply?.items ?? [];
  const open = all.filter(
    (i) => (i.status ?? "needs_action") === "needs_action",
  );
  return uniqueTodoItems(open);
};
