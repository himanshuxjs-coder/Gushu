import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getOrCreateConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ otherUserId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("get_or_create_conversation", {
      _other_user: data.otherUserId,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

export const checkConversationAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Check if conversation is hidden with a secret code for this user
    const { data: settings } = await context.supabase
      .from("conversation_settings")
      .select("is_hidden, secret_code_hash")
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId)
      .maybeSingle();

    const requiresSecretCode = settings?.is_hidden && settings?.secret_code_hash;
    return {
      requiresSecretCode: !!requiresSecretCode,
      isHidden: !!settings?.is_hidden,
    };
  });

export const listMyConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: convs, error } = await supabase
      .rpc("list_my_conversations" as any);
    if (error) throw new Error(error.message);

    const hiddenConversationIds = (convs ?? [])
      .filter((c: any) => c.hidden)
      .map((c: any) => c.id);

    const secretCodeMap = new Map<string, boolean>();
    if (hiddenConversationIds.length > 0) {
      const { data: secretSettings, error: secretError } = await supabase
        .from("conversation_settings")
        .select("conversation_id, secret_code_hash")
        .in("conversation_id", hiddenConversationIds)
        .eq("user_id", userId);
      if (secretError) throw new Error(secretError.message);
      for (const row of (secretSettings ?? []) as any[]) {
        if (row?.conversation_id) {
          secretCodeMap.set(row.conversation_id, !!row.secret_code_hash);
        }
      }
    }

    const results = (convs ?? []).map((c: any) => ({
      id: c.id,
      other: c.other ? {
        id: c.other.id,
        username: c.other.username,
        display_name: c.other.display_name,
        avatar_url: c.other.avatar_url,
        verified: c.other.verified,
        last_seen_at: c.other.last_seen_at,
      } : null,
      last: c.last ? {
        content: c.last.content,
        message_type: c.last.message_type,
        created_at: c.last.created_at,
        sender_id: c.last.sender_id,
      } : null,
      unread: Number(c.unread) || 0,
      last_message_at: c.last_message_at,
      hidden: c.hidden ?? false,
      locked: c.locked ?? false,
      hasPin: c.has_pin ?? false,
      hasSecretCode: secretCodeMap.get(c.id) ?? c.has_secret_code ?? false,
      cleared_at: c.cleared_at,
    }));

    return results;
  });

export const getConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: result, error } = await (supabase as any).rpc("get_conversation_with_header_data", {
      _conv_id: data.id,
      _user_id: userId,
    });
    
    if (error) {
      console.error(`[getConversation] RPC Error:`, error.message);
      // Fallback or throw
      throw new Error(error.message);
    }
    
    if (!result) return null;

    return {
      id: result.id,
      other: result.other ? {
        id: result.other.id,
        username: result.other.username,
        display_name: result.other.display_name,
        avatar_url: result.other.avatar_url,
        verified: result.other.verified,
        last_seen_at: result.other.last_seen_at,
      } : null
    };
  });

export const leaveConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: purged, error } = await context.supabase.rpc("leave_conversation", {
      _conv: data.id,
    });
    if (error) throw new Error(error.message);

    if (purged) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: objects, error: listError } = await supabaseAdmin.storage
        .from("chat-media")
        .list(data.id, { limit: 1000 });
      if (listError) {
        console.warn("Failed to list chat-media objects for purge:", listError.message);
      } else if (objects && objects.length > 0) {
        const paths = objects.map((obj) => `${data.id}/${obj.name}`);
        const { error: removeError } = await supabaseAdmin.storage
          .from("chat-media")
          .remove(paths);
        if (removeError) {
          console.warn("Failed to delete chat-media files for purge:", removeError.message);
        }
      }
    }

    return { purged: !!purged };
  });
