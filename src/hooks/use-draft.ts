import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getDraft, saveDraft } from "@/lib/drafts.functions";

const DEBOUNCE_MS = 180;

type Updater = string | ((prev: string) => string);

export function useDraft(conversationId: string) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const getFn = useServerFn(getDraft);
  const saveFn = useServerFn(saveDraft);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const textRef = useRef<string>("");
  const revisionRef = useRef(0);

  const syncText = useCallback((value: string, render = true) => {
    textRef.current = value;
    if (render) setText(value);
    const revision = ++revisionRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = value.trim();
      if (revision !== revisionRef.current || trimmed === lastSavedRef.current) return;
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

  // Used by the chat composer to keep the native textarea responsive without
  // rerendering the entire composer tree for every keystroke.
  const updateWithoutRender = useCallback(
    (valueOrUpdater: Updater) => {
      const next =
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(textRef.current)
          : valueOrUpdater;
      syncText(next, false);
    },
    [syncText],
  );

  const clear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setText("");
    textRef.current = "";
    lastSavedRef.current = "";
    revisionRef.current += 1;
    saveFn({ data: { conversationId, content: null } }).catch(() => {});
  }, [conversationId, saveFn]);

  return { text, setText: update, setTextWithoutRender: updateWithoutRender, textRef, clear, loaded };
}
