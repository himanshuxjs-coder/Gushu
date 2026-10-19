import { supabase } from "@/integrations/supabase/client";

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Subscribe to a channel and request a fresh server snapshot after the channel
 * successfully rejoins. Supabase Realtime manages WebSocket reconnections; the
 * callback here is a recovery signal for app-level missed events.
 *
 * Note: callers must still remove the returned channel in their effect cleanup.
 */
export function subscribeWithReconnect(
  channel: ReturnType<typeof supabase.channel>,
  onReconnect?: () => void,
): ReturnType<typeof supabase.channel> {
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let lastStatus: string | undefined;

  const statusCallback = (status: string, err?: Error) => {
    if (disposed) return;

    if (status === "SUBSCRIBED") {
      const wasReconnect = lastStatus !== undefined && lastStatus !== "SUBSCRIBED";
      attempt = 0;
      lastStatus = status;
      if (wasReconnect) onReconnect?.();
      return;
    }

    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      lastStatus = status;
      if (err) console.error("[Gushu Realtime] subscription status:", status, err);

      // Don't create a timer storm if the SDK emits multiple error statuses.
      if (retryTimer) return;

      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      attempt += 1;

      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (disposed) return;

        // Re-subscribe only after a channel-level failure. Supabase's client
        // handles normal WebSocket reconnection itself.
        try {
          channel.subscribe(statusCallback);
        } catch (retryError) {
          console.error("[Gushu Realtime] retry failed:", retryError);
        }
      }, delay);
    }
  };

  channel.subscribe(statusCallback);

  // Return the actual Supabase channel for existing call-site compatibility.
  // Cleanup remains via supabase.removeChannel(channel), which stops the
  // underlying channel. Any queued retry is harmless after CLOSED.
  return channel;
}
