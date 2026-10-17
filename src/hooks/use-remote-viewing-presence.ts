import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useChatVisibility } from "@/hooks/use-chat-visibility";

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];

type PresencePayload = {
  userId?: string;
  user_id?: string;
  key?: string;
  conversationId?: string;
  conversation_id?: string;
  viewing?: boolean;
};

type PresenceState = Record<string, PresencePayload[]>;

export function useRemoteViewingPresence(
  conversationId: string | undefined,
  meId: string,
  otherId: string | undefined,
): boolean {
  const [otherIsViewing, setOtherIsViewing] = useState(false);
  const isLocallyViewing = useChatVisibility(conversationId);
  const isLocallyViewingRef = useRef(isLocallyViewing);
  isLocallyViewingRef.current = isLocallyViewing;
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribedRef = useRef(false);

  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const otherIdRef = useRef(otherId);
  otherIdRef.current = otherId;

  const meIdRef = useRef(meId);
  meIdRef.current = meId;

  const isViewingInConversation = useCallback(
    (payload: PresencePayload, currentConvId: string) => {
      const payloadUserId = payload.userId ?? payload.user_id;
      const payloadConversationId = payload.conversationId ?? payload.conversation_id;
      return (
        payloadUserId !== meIdRef.current &&
        payloadConversationId === currentConvId &&
        payload.viewing === true
      );
    },
    [],
  );

  const setRemoteViewingState = useCallback((viewing: boolean) => {
    setOtherIsViewing(viewing);
  }, []);

  const readRemoteViewing = useCallback(
    (channel: ReturnType<typeof supabase.channel>) => {
      const currentOtherId = otherIdRef.current;
      const currentConvId = conversationIdRef.current;
      if (!currentOtherId || !currentConvId) {
        setRemoteViewingState(false);
        return;
      }

      const state = channel.presenceState() as PresenceState;
      if (!state || Object.keys(state).length === 0) {
        setRemoteViewingState(false);
        return;
      }

      // Only count an exact other-user entry for this conversation.
      const entriesForOther = state[currentOtherId];
      if (entriesForOther && entriesForOther.length > 0) {
        const isViewing = entriesForOther.some((payload) =>
          isViewingInConversation(payload, currentConvId),
        );
        setRemoteViewingState(isViewing);
        return;
      }

      // Fallback for clients that expose the participant ID in the payload.
      const allEntries = Object.values(state).flat();
      const isViewing = allEntries.some((payload) => {
        const payloadUserId = payload.userId ?? payload.user_id ?? payload.key;
        return payloadUserId === currentOtherId && isViewingInConversation(payload, currentConvId);
      });

      setRemoteViewingState(isViewing);
    },
    [isViewingInConversation, setRemoteViewingState],
  );

  const trackSelf = useCallback(
    (channel: ReturnType<typeof supabase.channel>, viewing: boolean) => {
      const currentConvId = conversationIdRef.current;
      const currentMeId = meIdRef.current;
      if (!currentConvId || !currentMeId) return;

      if (viewing) {
        void channel
          .track({ userId: currentMeId, conversationId: currentConvId, viewing: true })
          .catch(() => {});
      } else {
        void channel.untrack().catch(() => {});
      }
    },
    [],
  );


  useEffect(() => {
    if (!conversationId || !meId) {
      setOtherIsViewing(false);
      return;
    }

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const removeActiveChannel = () => {
      subscribedRef.current = false;
      const channel = activeChannel;
      activeChannel = null;
      channelRef.current = null;
      if (channel) {
        void channel.untrack().catch(() => {});
        void supabase.removeChannel(channel).catch(() => {});
      }
    };

    let createChannel: () => void;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer || subscribedRef.current) return;
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (disposed) return;
        removeActiveChannel();
        createChannel();
      }, delay);
    };

    createChannel = () => {
      if (disposed) return;
      removeActiveChannel();

      const channel = supabase.channel(`presence:viewing:${conversationId}`, {
        config: { presence: { key: meId } },
      });
      activeChannel = channel;
      channelRef.current = channel;

      channel
        .on("presence", { event: "sync" }, () => {
          if (channelRef.current === channel) readRemoteViewing(channel);
        })
        .on("presence", { event: "join" }, () => {
          if (channelRef.current === channel) readRemoteViewing(channel);
        })
        .on("presence", { event: "leave" }, (event: any) => {
          if (channelRef.current !== channel) return;
          const currentOtherId = otherIdRef.current;
          const leftKey = event?.key;
          const leftOther = leftKey === currentOtherId || (event?.leftPresences ?? []).some(
            (payload: PresencePayload) =>
              (payload.userId ?? payload.user_id) === currentOtherId,
          );
          if (leftOther) {
            setRemoteViewingState(false);
            window.setTimeout(() => {
              if (channelRef.current === channel) readRemoteViewing(channel);
            }, 50);
            return;
          }
          readRemoteViewing(channel);
        })
        .subscribe((status) => {
          if (channelRef.current !== channel || disposed) return;
          if (status === "SUBSCRIBED") {
            subscribedRef.current = true;
            reconnectAttempt = 0;
            trackSelf(channel, isLocallyViewingRef.current);
            readRemoteViewing(channel);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            subscribedRef.current = false;
            scheduleReconnect();
          }
        });
    };

    const handleVisibilityChange = () => {
      const channel = channelRef.current;
      if (!channel) return;
      const viewing = document.visibilityState === "visible" && document.hasFocus();
      trackSelf(channel, viewing);
      readRemoteViewing(channel);
    };

    const handleBlur = () => {
      const channel = channelRef.current;
      if (channel) void channel.untrack().catch(() => {});
    };

    const handlePageHide = () => {
      const channel = channelRef.current;
      if (channel) void channel.untrack().catch(() => {});
    };

    createChannel();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("focus", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("online", handleVisibilityChange);

    return () => {
      disposed = true;
      clearReconnectTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("focus", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("online", handleVisibilityChange);
      removeActiveChannel();
      setOtherIsViewing(false);
    };
  }, [conversationId, meId, readRemoteViewing, trackSelf]);

  // Sync self presence when local visibility state changes
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    trackSelf(channel, isLocallyViewing);
  }, [isLocallyViewing, trackSelf]);

  // Re-read presence when otherId is resolved (e.g. after conv.data finishes loading)
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || !otherId) return;
    readRemoteViewing(channel);
  }, [otherId, readRemoteViewing]);


  return otherIsViewing;
}