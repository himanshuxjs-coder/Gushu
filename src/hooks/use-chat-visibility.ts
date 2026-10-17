import { useEffect, useState } from "react";

/**
 * Returns true when the user is actively viewing the given chat:
 *   1. A conversation is selected (conversationId is truthy)
 *   2. The browser tab is visible and the window is focused
 *
 * This provides reliable presence tracking across desktop and mobile
 * without false-negative drops from focus/blur events.
 */
export function useChatVisibility(conversationId: string | undefined): boolean {
  const [isChatActive, setIsChatActive] = useState(() => {
    if (typeof document === "undefined") return false;
    return Boolean(conversationId && document.visibilityState === "visible" && document.hasFocus());
  });

  useEffect(() => {
    if (!conversationId || typeof document === "undefined") {
      setIsChatActive(false);
      return;
    }

    const update = () => {
      const visible = document.visibilityState === "visible" && document.hasFocus();
      setIsChatActive(visible);
    };

    update();

    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    window.addEventListener("pagehide", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);

    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("pagehide", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      setIsChatActive(false);
    };

  }, [conversationId]);

  return isChatActive;
}
