import { supabase } from "@/integrations/supabase/client";
import {
  listPendingTextMessages,
  removePendingTextMessage,
  type LocalChatMessage,
} from "@/lib/local-chat-cache";

export async function flushPendingTextMessages(userId: string) {
  const pendingMessages = await listPendingTextMessages(userId);
  const sent: LocalChatMessage[] = [];
  const failedIds: string[] = [];

  for (const pending of pendingMessages) {
    if (typeof navigator !== "undefined" && !navigator.onLine) break;

    try {
      const { data, error } = await supabase
        .from("messages")
        .insert(pending.payload)
        .select()
        .single();

      if (error?.code === "23505") {
        const { data: existing, error: lookupError } = await supabase
          .from("messages")
          .select()
          .eq("id", pending.id)
          .eq("sender_id", userId)
          .maybeSingle();
        if (lookupError) break;
        if (existing) {
          sent.push(existing as LocalChatMessage);
          await removePendingTextMessage(pending.id);
          continue;
        }
      }

      if (error) {
        if (/network|fetch|timeout|connection|abort/i.test(error.message)) break;
        // Keep failed rows in the durable outbox. A response can fail after the
        // server accepted the insert, and the stable ID lets a later retry safely
        // detect an existing row instead of losing the user's message.
        failedIds.push(pending.id);
        continue;
      }

      if (data) {
        sent.push(data as LocalChatMessage);
        await removePendingTextMessage(pending.id);
      }
    } catch {
      break;
    }
  }

  return { sent, failedIds };
}
