import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getDraft, saveDraft } from "@/lib/drafts.functions";

const DEBOUNCE_MS = 800;

type Updater = string | ((prev: string) => string);

export function useDraft(conversationId: string) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const getFn = useServerFn(getDraft);
  const saveFn = useServerFn(saveDraft);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const textRef = useRef<string>("");

  const syncText = useCallback((value: string) => {
    textRef.current = value;
    setText(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = value.trim();
      if (trimmed === lastSavedRef.current) return;
      lastSavedRef.current = trimmed;
      saveFn({
        data: { conversationId, content: trimmed || null },
      }).catch(() => {});
    }, DEBOUNCE_MS);
  }, [conversationId, saveFn]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setText("");
    textRef.current = "";
    lastSavedRef.current = "";
    getFn({ data: { conversationId } })
      .then((r) => {
        if (cancelled) return;
        if (r.content) {
          setText(r.content);
          textRef.current = r.content;
          lastSavedRef.current = r.content;
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [conversationId, getFn]);

  const update = useCallback(
    (valueOrUpdater: Updater) => {
      const next =
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(textRef.current)
          : valueOrUpdater;
      syncText(next);
    },
    [syncText],
  );

  const clear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setText("");
    textRef.current = "";
    lastSavedRef.current = "";
    saveFn({ data: { conversationId, content: null } }).catch(() => {});
  }, [conversationId, saveFn]);

  return { text, setText: update, clear, loaded };
}
