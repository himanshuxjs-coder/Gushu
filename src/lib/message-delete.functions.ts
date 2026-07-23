import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const deleteForMe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ messageId: z.string().uuid(), conversationId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { error } = await supabase.from("message_deletions").upsert(
      {
        message_id: data.messageId,
        user_id: userId,
        deleted_for_all: false,
      },
      { onConflict: "message_id,user_id" },
    );
    if (error) throw error;

    const { data: conv } = await supabase
      .from("conversations")
      .select("user1_id, user2_id")
      .eq("id", data.conversationId)
      .maybeSingle();

    if (conv) {
      const participants = [conv.user1_id, conv.user2_id];
      const { data: deletions } = await supabase
        .from("message_deletions")
        .select("user_id")
        .eq("message_id", data.messageId);

      const deletedUserIds = (deletions ?? []).map((d) => d.user_id);
      const allParticipantsDeleted = participants.every((p) => deletedUserIds.includes(p));

      if (allParticipantsDeleted) {
        const { data: msg } = await supabase
          .from("messages")
          .select("media_path")
          .eq("id", data.messageId)
          .maybeSingle();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.from("message_deletions").delete().eq("message_id", data.messageId);
        await supabaseAdmin.from("messages").delete().eq("id", data.messageId);

        if (msg?.media_path) {
          await supabaseAdmin.storage.from("chat-media").remove([msg.media_path]);
        }
      }
    }

    return { ok: true };
  });

export const expireMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ messageId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Delegate to the server-side purge system, which cascades deletes
    // across all dependent tables and broadcasts realtime removal for all
    // eligible messages. The client-side timer fires when delete_after
    // (mirrored to expires_at) has passed, so this RPC will pick up the
    // target message along with any others that are due.
    const { error } = await supabase.rpc("purge_expired_disappearing_messages");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteForEveryone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ messageId: z.string().uuid(), conversationId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: msg } = await context.supabase
      .from("messages")
      .select("sender_id, media_path")
      .eq("id", data.messageId)
      .maybeSingle();

    if (!msg) throw new Error("Message not found");
    if (msg.sender_id !== context.userId) {
      throw new Error("Only the sender can delete for everyone");
    }

    if (msg.media_path) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.storage.from("chat-media").remove([msg.media_path]);
    }

    const { error } = await context.supabase.rpc("soft_delete_message_for_everyone", {
      _msg_id: data.messageId,
      _sender_id: context.userId,
    });

    if (error) throw error;

    return { ok: true };
  });

export const markViewed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ messageId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("mark_message_viewed", {
      _msg_id: data.messageId,
      _viewer_id: context.userId,
    } as any);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
