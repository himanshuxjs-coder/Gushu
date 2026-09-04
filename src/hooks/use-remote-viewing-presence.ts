import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useChatVisibility } from "@/hooks/use-chat-visibility";

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 16000];
const FALLBACK_POLL_MS = 3000;

/**
 * Two-user remote viewing presence system.
 *
 * LOCAL: publishes whether the current user is actively viewing this conversation
 *   (conversation selected + tab visible + window focused) via Supabase Realtime Presence.
 *
 * REMOTE: tracks whether the OTHER participant is actively viewing this conversation
 *   and returns that as `otherIsViewing`. This is what drives the indicator.
 *
 * The current user never sees their own presence — only the other participant's.
 *
 * Self-healing: automatically reconnects after network drops, re-syncs after tab
 * visibility changes, and prevents stale/duplicate subscriptions.
 */
export function useRemoteViewingPresence(
  conversationId: string | undefined,
  meId: string,
  otherId: string | undefined,
): boolean {
  const [otherIsViewing, setOtherIsViewing] = useState(false);
  const isLocallyViewing = useChatVisibility(conversationId);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribedRef = useRef(false);
  const viewingRef = useRef(false);
  const conversationIdRef = useRef<string | undefined>(conversationId);
  const otherIdRef = useRef<string | undefined>(otherId);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rawViewingRef = useRef(false);
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  viewingRef.current = isLocallyViewing;
  conversationIdRef.current = conversationId;
  otherIdRef.current = otherId;

  const setViewingDebounced = useCallback((viewing: boolean) => {
    rawViewingRef.current = viewing;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (viewing) {
      setOtherIsViewing(true);
    } else {
      debounceTimerRef.current = setTimeout(() => {
        if (!rawViewingRef.current) {
          setOtherIsViewing(false);
        }
        debounceTimerRef.current = null;
      }, 600);
    }
  }, []);

  const syncRemotePresence = useCallback(() => {
    const channel = channelRef.current;
    const currentOtherId = otherIdRef.current;
    if (!channel || !currentOtherId) return;

    const state = channel.presenceState();
    const otherPresence = state[currentOtherId];
    setViewingDebounced(!!otherPresence);
  }, [setViewingDebounced]);

  const publishLocalPresence = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !subscribedRef.current) return;

    if (viewingRef.current) {
      channel.send({
        type: "presence",
        event: "track",
        payload: { user_id: meId, viewing: true },
      });
    } else {
      channel.send({ type: "presence", event: "untrack" });
    }
  }, [meId]);

  // Main effect: create/recreate the channel when conversation or user changes
  useEffect(() => {
    if (!conversationId || !meId) {
      setOtherIsViewing(false);
      rawViewingRef.current = false;
      return;
    }

    subscribedRef.current = false;
    rawViewingRef.current = false;
    setOtherIsViewing(false);

    if (channelRef.current) {
      try {
        supabase.removeChannel(channelRef.current);
      } catch {}
      channelRef.current = null;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (fallbackPollRef.current) {
      clearInterval(fallbackPollRef.current);
      fallbackPollRef.current = null;
    }

    if (initialSyncTimerRef.current) {
      clearTimeout(initialSyncTimerRef.current);
      initialSyncTimerRef.current = null;
    }

    reconnectAttemptRef.current = 0;

    const channel = supabase.channel(`presence:viewing:${conversationId}`, {
      config: { presence: { key: meId } },
    });

    channelRef.current = channel;

    const handleReconnect = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      const delay =
        RECONNECT_DELAYS[
          Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1)
        ];
      reconnectAttemptRef.current++;

      reconnectTimerRef.current = setTimeout(() => {
        const currentChannel = channelRef.current;
        if (!currentChannel || currentChannel !== channel) return;
        channel.subscribe();
      }, delay);
    };

    channel
      .on("presence", { event: "sync" }, () => {
        syncRemotePresence();
      })
      .on("presence", { event: "join" }, ({ key }) => {
        if (key === otherIdRef.current) {
          setViewingDebounced(true);
        }
      })
      .on("presence", { event: "leave" }, ({ key }) => {
        if (key === otherIdRef.current) {
          setViewingDebounced(false);
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          subscribedRef.current = true;
          reconnectAttemptRef.current = 0;
          publishLocalPresence();
          syncRemotePresence();

          // Schedule a few extra syncs in the first 2 seconds to catch
          // the other user's presence arriving shortly after we join.
          // This fixes the "first load needs manual refresh" issue where
          // both users join nearly simultaneously and the initial sync
          // misses the other's presence by a split second.
          initialSyncTimerRef.current = setTimeout(() => {
            if (subscribedRef.current) {
              publishLocalPresence();
              syncRemotePresence();
            }
          }, 500);

          setTimeout(() => {
            if (subscribedRef.current && channelRef.current === channel) {
              publishLocalPresence();
              syncRemotePresence();
            }
          }, 1500);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          subscribedRef.current = false;
          handleReconnect();
        } else if (status === "CLOSED") {
          subscribedRef.current = false;
          handleReconnect();
        }
      });

    // Lightweight fallback: every 3s, re-sync remote presence. This reads
    // local channel state only — no network round-trips. It catches missed
    // sync events and is the safety net for first-load race conditions.
    fallbackPollRef.current = setInterval(() => {
      if (subscribedRef.current && otherIdRef.current) {
        syncRemotePresence();
      }
    }, FALLBACK_POLL_MS);

    return () => {
      subscribedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
      if (initialSyncTimerRef.current) {
        clearTimeout(initialSyncTimerRef.current);
        initialSyncTimerRef.current = null;
      }
      if (channelRef.current) {
        try {
          channelRef.current.send({ type: "presence", event: "untrack" }).catch(() => {});
        } catch {}
        try {
          supabase.removeChannel(channelRef.current);
        } catch {}
        channelRef.current = null;
      }
      setOtherIsViewing(false);
      rawViewingRef.current = false;
    };
  }, [conversationId, meId, publishLocalPresence, syncRemotePresence, setViewingDebounced]);

  /**
   * CRITICAL: When otherId becomes available (conversation data loads
   * after the channel is already subscribed), re-sync AND re-publish.
   * Re-publishing is key: it forces a presence sync on the channel which
   * triggers the other user's presence to be re-broadcast to us.
   */
  useEffect(() => {
    if (otherId && subscribedRef.current) {
      publishLocalPresence();
      syncRemotePresence();
    }
  }, [otherId, publishLocalPresence, syncRemotePresence]);

  /**
   * When local viewing state changes, publish the new state to the channel.
   */
  useEffect(() => {
    publishLocalPresence();
  }, [isLocallyViewing, publishLocalPresence]);

  /**
   * When the tab becomes visible/focused again, re-sync remote presence.
   */
  useEffect(() => {
    if (!conversationId) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        publishLocalPresence();
        syncRemotePresence();
      }
    };

    const handleFocus = () => {
      publishLocalPresence();
      syncRemotePresence();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [conversationId, publishLocalPresence, syncRemotePresence]);

  return otherIsViewing;
}
