import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getConversationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const [settingsRes, convRes] = await Promise.all([
      context.supabase
        .from("conversation_settings")
        .select("*")
        .eq("conversation_id", data.conversationId)
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("conversations")
        .select("expiry_seconds")
        .eq("id", data.conversationId)
        .maybeSingle(),
    ]);

    let row = settingsRes.data;

    if (!row) {
      const { data: newRow, error } = await context.supabase
        .from("conversation_settings")
        .insert({
          conversation_id: data.conversationId,
          user_id: context.userId,
          theme: "obsidian",
          is_locked: false,
          is_hidden: false,
          notification_enabled: false,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      row = newRow;
    }

    return {
      ...(row as any),
      expiry_seconds: (convRes.data as any)?.expiry_seconds ?? null,
    };
  });

export const setConversationPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), pin: z.string().regex(/^\d{6}$/) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(data.pin, 10);
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, pin_hash: hash, is_locked: true },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const verifyConversationPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), pin: z.string().regex(/^\d{6}$/) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("conversation_settings")
      .select("pin_hash")
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId)
      .single();
    if (!row?.pin_hash) return { valid: false };
    const bcrypt = await import("bcryptjs");
    const valid = await bcrypt.compare(data.pin, row.pin_hash);
    return { valid };
  });

export const removeConversationPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .update({ pin_hash: null, is_locked: false })
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleConversationLock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), locked: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .update({ is_locked: data.locked })
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleConversationHidden = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), hidden: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, is_hidden: data.hidden },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), clearSaved: z.boolean().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const clearedAt = new Date().toISOString();
    const cutoff = clearedAt;

    const { error: settingsError } = await supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: userId, cleared_at: clearedAt },
        { onConflict: "conversation_id,user_id" },
      );
    if (settingsError) throw new Error(settingsError.message);

    const { data: existingMessages, error: messagesError } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", data.conversationId)
      .lte("created_at", cutoff);
    if (messagesError) throw new Error(messagesError.message);

    const messageIds = (existingMessages ?? []).map((m: any) => m.id as string);
    if (messageIds.length > 0) {
      if (data.clearSaved) {
        const { error: saveDeleteError } = await supabase
          .from("message_saves")
          .delete()
          .eq("user_id", userId)
          .eq("conversation_id", data.conversationId);
        if (saveDeleteError) throw new Error(saveDeleteError.message);
      }

      const { data: mySaves, error: savesError } = await supabase
        .from("message_saves")
        .select("message_id")
        .eq("user_id", userId)
        .eq("conversation_id", data.conversationId)
        .in("message_id", messageIds);
      if (savesError) throw new Error(savesError.message);

      const savedIds = new Set((mySaves ?? []).map((s: any) => s.message_id as string));
      const messageIdsToDeleteForMe = (data.clearSaved
        ? messageIds
        : messageIds.filter((messageId) => !savedIds.has(messageId)));

      if (messageIdsToDeleteForMe.length > 0) {
        const rows = messageIdsToDeleteForMe.map((messageId) => ({
          message_id: messageId,
          user_id: userId,
          deleted_for_all: false,
        }));
        const { error: deletionError } = await supabase.from("message_deletions").upsert(rows, {
          onConflict: "message_id,user_id",
        });
        if (deletionError) throw new Error(deletionError.message);
      }
    }

    return { ok: true, clearedAt };
  });

export const removeFromInbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, removed_at: new Date().toISOString() } as any,
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setConversationExpiry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), seconds: z.number().nullable() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("display_name, username")
      .eq("id", context.userId)
      .single();

    const name = profile?.display_name || profile?.username || "Someone";

    let durationLabel = "Never";
    if (data.seconds === 3600) durationLabel = "1 Hour";
    else if (data.seconds === 21600) durationLabel = "6 Hours";
    else if (data.seconds === 43200) durationLabel = "12 Hours";
    else if (data.seconds === 86400) durationLabel = "24 Hours";
    else if (data.seconds === 604800) durationLabel = "7 Days";
    else if (data.seconds === 1800) durationLabel = "30 Minutes";

    const systemText =
      data.seconds === null
        ? `${name} disabled disappearing messages.`
        : `${name} changed disappearing messages to ${durationLabel}.`;

    const { error: updateError } = await context.supabase
      .from("conversations")
      .update({ expiry_seconds: data.seconds })
      .eq("id", data.conversationId);

    if (updateError) throw new Error(updateError.message);

    try {
      await context.supabase.from("messages").insert({
        conversation_id: data.conversationId,
        sender_id: context.userId,
        content: systemText,
        message_type: "system",
      });
    } catch {}

    return { ok: true };
  });

export const setConversationTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), theme: z.string() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, theme: data.theme },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setConversationWallpaper = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), wallpaperUrl: z.string().nullable() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, wallpaper_url: data.wallpaperUrl },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setConversationNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, notification_enabled: data.enabled },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setConversationSecretCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), code: z.string().min(4).max(50) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(data.code, 10);
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        { conversation_id: data.conversationId, user_id: context.userId, secret_code_hash: hash },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const verifyConversationSecretCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid(), code: z.string().min(4).max(50) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("conversation_settings")
      .select("secret_code_hash")
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!row?.secret_code_hash) return { valid: true };
    const bcrypt = await import("bcryptjs");
    const valid = await bcrypt.compare(data.code, row.secret_code_hash);
    return { valid };
  });

export const removeConversationSecretCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversation_settings")
      .update({ secret_code_hash: null })
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setHiddenWithSecretCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({
      conversationId: z.string().uuid(),
      hidden: z.boolean(),
      code: z.string().min(4).max(50).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    let secretCodeHash = null;
    if (data.hidden && data.code) {
      const bcrypt = await import("bcryptjs");
      secretCodeHash = await bcrypt.hash(data.code, 10);
    }
    const { error } = await context.supabase
      .from("conversation_settings")
      .upsert(
        {
          conversation_id: data.conversationId,
          user_id: context.userId,
          is_hidden: data.hidden,
          secret_code_hash: secretCodeHash,
        },
        { onConflict: "conversation_id,user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const findHiddenChatByCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ code: z.string().min(4).max(50) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const bcrypt = await import("bcryptjs");
    const { data: hiddenChats, error } = await context.supabase
      .from("conversation_settings")
      .select("conversation_id, secret_code_hash")
      .eq("user_id", context.userId)
      .eq("is_hidden", true)
      .not("secret_code_hash", "is", null);
    if (error) throw new Error(error.message);
    for (const chat of hiddenChats ?? []) {
      if (chat.secret_code_hash) {
        const match = await bcrypt.compare(data.code, chat.secret_code_hash);
        if (match) {
          return { found: true, conversationId: chat.conversation_id };
        }
      }
    }
    return { found: false, conversationId: null };
  });
