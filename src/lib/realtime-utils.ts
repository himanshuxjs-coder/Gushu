import { supabase } from "@/integrations/supabase/client";

/**
 * Subscribe once and use Supabase Realtime's built-in WebSocket/channel
 * recovery. Re-subscribing the same channel from a timer can race the SDK's
 * own rejoin logic and create confusing subscription states.
 *
 * onReconnect runs only after a channel has left SUBSCRIBED and successfully
 * returns to SUBSCRIBED. onSubscribed runs after the initial successful subscription.
 * Both allow callers to reconcile any missed database events incrementally.
 */
export function subscribeWithReconnect(
  channel: ReturnType<typeof supabase.channel>,
  onReconnect?: () => void,
  onSubscribed?: () => void,
): ReturnType<typeof supabase.channel> {
  let lastStatus: string | undefined;

  channel.subscribe((status: string, err?: Error) => {
    if (status === "SUBSCRIBED") {
      const recovered = lastStatus !== undefined && lastStatus !== "SUBSCRIBED";
      if (recovered) {
        console.info("[Gushu Realtime] channel recovered; syncing missed updates");
        onReconnect?.();
      } else {
        console.info("[Gushu Realtime] channel subscribed");
        if (lastStatus === undefined) onSubscribed?.();
      }
      lastStatus = status;
      return;
    }

    lastStatus = status;
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      console.warn("[Gushu Realtime] channel status:", status, err ?? "");
    }
  });

  return channel;
}
