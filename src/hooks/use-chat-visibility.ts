import { useEffect, useState } from "react";

/**
 * Returns true when the user is actively viewing the given chat:
 *   1. A conversation is selected (conversationId is truthy)
 *   2. The browser tab is visible (document.visibilityState === "visible")
 *   3. The window has focus (document.hasFocus())
 *
 * If any of those become false, this returns false immediately so the
 * indicator can animate out.
 */
export function useChatVisibility(conversationId: string | undefined): boolean {
  const [isChatActive, setIsChatActive] = useState(false);

  useEffect(() => {
    if (!conversationId) {
      setIsChatActive(false);
      return;
    }

    const update = () => {
      const visible = document.visibilityState === "visible";
        const active = visible && document.hasFocus();
      setIsChatActive(active);
    };

    update();

    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);

    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      setIsChatActive(false);
    };
  }, [conversationId]);

  return isChatActive;
}
