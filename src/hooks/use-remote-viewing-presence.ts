import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useChatVisibility } from "@/hooks/use-chat-visibility";

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 16000];
const REMOTE_CLEAR_DELAY = 300;

type PresencePayload = {
  userId?: string;
  conversationId?: string;
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
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribedRef = useRef(false);
  const conversationIdRef = useRef(conversationId);
  const otherIdRef = useRef(otherId);
  const clearRemoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  conversationIdRef.current = conversationId;
  otherIdRef.current = otherId;

  useEffect(() => {
    if (!conversationId || !meId) {
      setOtherIsViewing(false);
      return;
    }

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeChannel: ReturnType<typeof supabase.channel> | null = null;

    const clearRemoteTimer = () => {
      if (clearRemoteTimerRef.current) {
        clearTimeout(clearRemoteTimerRef.current);
        clearRemoteTimerRef.current = null;
      }
    };

    const setRemoteViewing = (viewing: boolean) => {
      clearRemoteTimer();
      if (viewing) {
        setOtherIsViewing(true);
        return;
      }
      clearRemoteTimerRef.current = setTimeout(() => {
        setOtherIsViewing(false);
        clearRemoteTimerRef.current = null;
      }, REMOTE_CLEAR_DELAY);
    };

    const readRemoteViewing = (channel: ReturnType<typeof supabase.channel>) => {
      const currentOtherId = otherIdRef.current;
      const currentConversationId = conversationIdRef.current;
      if (!currentOtherId || !currentConversationId) {
        setRemoteViewing(false);
        return;
      }

      const state = channel.presenceState() as PresenceState;
      const viewing = (state[currentOtherId] ?? []).some(
        (presence) =>
          presence.userId === currentOtherId &&
          presence.conversationId === currentConversationId &&
          presence.viewing === true,
      );
      setRemoteViewing(viewing);
    };

    const isActivelyViewing = () =>
      Boolean(
        conversationIdRef.current &&
          document.visibilityState === "visible" &&
          document.hasFocus(),
      );

    const trackCurrentViewing = (channel: ReturnType<typeof supabase.channel>) => {
      if (!subscribedRef.current || channelRef.current !== channel) return;

      if (isActivelyViewing()) {
        void channel
          .track({ userId: meId, conversationId, viewing: true })
          .catch(() => {});
      } else {
        void channel.untrack().catch(() => {});
      }
    };

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
      if (channel) void supabase.removeChannel(channel).catch(() => {});
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
        .on("presence", { event: "leave" }, () => {
          if (channelRef.current === channel) readRemoteViewing(channel);
        })
        .subscribe((status) => {
          if (channelRef.current !== channel || disposed) return;
          if (status === "SUBSCRIBED") {
            subscribedRef.current = true;
            reconnectAttempt = 0;
            trackCurrentViewing(channel);
            readRemoteViewing(channel);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            subscribedRef.current = false;
            scheduleReconnect();
          }
        });
    };

    const updateViewingPresence = () => {
      const channel = channelRef.current;
      if (!channel || !subscribedRef.current) {
        scheduleReconnect();
        return;
      }
      trackCurrentViewing(channel);
      readRemoteViewing(channel);
    };

    const handleVisibilityChange = () => updateViewingPresence();
    const handleFocus = () => updateViewingPresence();
    const handleBlur = () => updateViewingPresence();
    const handleOnline = () => updateViewingPresence();
    const handlePageShow = () => updateViewingPresence();

    createChannel();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearRemoteTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pageshow", handlePageShow);
      removeActiveChannel();
      setOtherIsViewing(false);
    };
  }, [conversationId, meId]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || !subscribedRef.current) return;
    if (isLocallyViewing) {
      void channel.track({ userId: meId, conversationId, viewing: true }).catch(() => {});
    } else {
      void channel.untrack().catch(() => {});
    }
  }, [conversationId, isLocallyViewing, meId]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || !subscribedRef.current || !otherId) {
      if (!otherId) setOtherIsViewing(false);
      return;
    }

    const state = channel.presenceState() as PresenceState;
    const viewing = (state[otherId] ?? []).some(
      (presence) =>
        presence.userId === otherId &&
        presence.conversationId === conversationId &&
        presence.viewing === true,
    );
    setOtherIsViewing(viewing);
  }, [conversationId, otherId]);

  return otherIsViewing;
}