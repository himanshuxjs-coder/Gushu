import { useEffect, useState } from "react";

/**
 * Returns true when the user is actively viewing the given chat:
 *   1. A conversation is selected (conversationId is truthy)
 *   2. The browser tab is visible (document.visibilityState === "visible")
 *   3. The window has focus (document.hasFocus())
 *
 * On mobile, document.hasFocus() is unreliable, so we relax that check
 * when the viewport is narrow — visibility alone is sufficient on mobile.
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

    const isMobile =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(max-width: 768px)").matches ?? false);

    const update = () => {
      const visible = document.visibilityState === "visible";
      // On mobile, hasFocus() is unreliable — treat visible as sufficient.
      // On desktop, require both visible AND focused.
      const active = isMobile ? visible : visible && document.hasFocus();
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
