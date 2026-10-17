import { supabase } from "@/integrations/supabase/client";

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

export function subscribeWithReconnect(
  channel: ReturnType<typeof supabase.channel>,
  onReconnect?: () => void,
): ReturnType<typeof supabase.channel> {
  let attempt = 0;

  channel.subscribe((status: string) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      attempt++;
      setTimeout(() => {
        channel.subscribe();
        if (onReconnect) onReconnect();
      }, delay);
    } else if (status === "SUBSCRIBED") {
      attempt = 0;
    }
  });

  return channel;
}
