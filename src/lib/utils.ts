import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function debounceInvalidation(
  qc: import("@tanstack/react-query").QueryClient,
  keys: string[][],
  ms = 300,
) {
  const tag = keys.map((k) => k.join("/")).join("|");
  const existing = (qc as any).__debounceMap;
  const map: Map<string, ReturnType<typeof setTimeout>> = existing ?? new Map();
  if (!existing) (qc as any).__debounceMap = map;
  const prev = map.get(tag);
  if (prev) clearTimeout(prev);
  map.set(
    tag,
    setTimeout(() => {
      map.delete(tag);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
    }, ms),
  );
}

/**
 * Merge incoming server messages into the existing cached list without losing
 * any messages. Dedupes by permanent database id, preserving newer/local state.
 * Returns a chronologically sorted (ascending by created_at) array.
 */
export function mergeMessages(existing: any[], incoming: any[]): any[] {
  const map = new Map<string, any>();

  // Seed with existing messages (preserves optimistic + local-only entries)
  for (const m of existing ?? []) {
    if (m && m.id) map.set(m.id, m);
  }

  // Merge incoming, preferring the server version for confirmed (non-optimistic) rows
  for (const m of incoming ?? []) {
    if (!m || !m.id) continue;
    const prev = map.get(m.id);
    if (prev) {
      // Preserve local UI state such as read receipts until the server confirms them.
      map.set(m.id, {
        ...prev,
        ...m,
        seen_at: m.seen_at ?? prev.seen_at ?? null,
        read_at: m.read_at ?? prev.read_at ?? null,
        first_read_at: m.first_read_at ?? prev.first_read_at ?? null,
        viewed_at: m.viewed_at ?? prev.viewed_at ?? null,
        is_optimistic: false,
        reactions: m.reactions ?? prev.reactions ?? [],
        is_saved: m.is_saved ?? prev.is_saved ?? false,
        saved_by_me: m.saved_by_me ?? prev.saved_by_me ?? false,
        replied_message: m.replied_message ?? prev.replied_message ?? null,
      });
    } else {
      map.set(m.id, { ...m, is_optimistic: false });
    }
  }

  // Sort ascending by created_at, fallback to insertion order for equal timestamps
  const result = Array.from(map.values());
  result.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return ta - tb || String(a.id).localeCompare(String(b.id));
  });
  return result;
}

/**
 * Insert a single realtime message into the cache, merging by id.
 * If an optimistic message matches (same sender + content + close timestamp),
 * replace it in-place; otherwise append.
 */
export function mergeRealtimeMessage(existing: any[], msg: any): any[] {
  if (!msg || !msg.id) return existing ?? [];

  const list = existing ?? [];
  const sortTimeline = (messages: any[]) =>
    messages.sort((a, b) => {
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return timeDiff || String(a.id).localeCompare(String(b.id));
    });

  // Receipt and edit events are frequent. Preserve the existing array order
  // for ordinary field updates; sort only if the authoritative timestamp moved.
  const existingIndex = list.findIndex((item) => item.id === msg.id);
  if (existingIndex >= 0) {
    const previous = list[existingIndex];
    const updated = {
      ...previous,
      ...msg,
      seen_at: msg.seen_at ?? previous.seen_at ?? null,
      read_at: msg.read_at ?? previous.read_at ?? null,
      first_read_at: msg.first_read_at ?? previous.first_read_at ?? null,
      viewed_at: msg.viewed_at ?? previous.viewed_at ?? null,
      is_optimistic: false,
    };
    const next = list.slice();
    next[existingIndex] = updated;
    return previous.created_at === updated.created_at ? next : sortTimeline(next);
  }

  // Replace the optimistic row by its permanent id. The database timestamp is
  // authoritative, so never keep the old optimistic array position.
  const confirmedTs = new Date(msg.created_at).getTime();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item.is_optimistic) continue;
    if (
      item.sender_id === msg.sender_id &&
      item.content === msg.content &&
      (item.reply_to ?? null) === (msg.reply_to ?? null)
    ) {
      const optTs = new Date(item.created_at).getTime();
      if (Math.abs(optTs - confirmedTs) < 10_000) {
        const copy = list.slice();
        copy[i] = {
          ...msg,
          is_optimistic: false,
          reactions: msg.reactions ?? item.reactions ?? [],
          is_saved: msg.is_saved ?? item.is_saved ?? false,
          saved_by_me: msg.saved_by_me ?? item.saved_by_me ?? false,
          replied_message: msg.replied_message ?? item.replied_message ?? null,
        };
        return sortTimeline(copy);
      }
    }
  }

  return sortTimeline([...list, { ...msg, is_optimistic: false }]);
}
