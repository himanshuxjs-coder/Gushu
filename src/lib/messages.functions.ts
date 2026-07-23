import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const messageKind = z.enum(["text", "image", "video", "file", "audio", "system"]);

async function enrichMessages({
  supabase,
  userId,
  conversationId,
  rows,
}: {
  supabase: any;
  userId: string;
  conversationId: string;
  rows: any[];
}) {
  const visible = rows ?? [];
  const allIds = visible.map((r: any) => r.id as string);
  if (allIds.length === 0) return [];

  const savedRes = await supabase
    .from("message_saves" as any)
    .select("message_id, user_id")
    .eq("conversation_id", conversationId);

  const savedData = savedRes.data ?? [];
  const allSavedIds = Array.from(new Set(savedData.map((s: any) => s.message_id as string)));
  const mySavedIds = savedData.filter((s: any) => s.user_id === userId).map((s: any) => s.message_id as string);

  const { data: deletions } = await supabase
    .from("message_deletions")
    .select("message_id")
    .eq("user_id", userId)
    .in("message_id", allIds);

  const deletedForMe = new Set((deletions ?? []).map((d: any) => d.message_id as string));
  const finalVisible = visible.filter((r: any) => !deletedForMe.has(r.id));

  const { data: reactionsData } = await supabase
    .from("message_reactions")
    .select("message_id, user_id, emoji")
    .in("message_id", finalVisible.map((r: any) => r.id));

  const reactionsByMsg = new Map<string, { user_id: string; emoji: string }[]>();
  for (const r of reactionsData ?? []) {
    const arr = reactionsByMsg.get(r.message_id) ?? [];
    arr.push({ user_id: r.user_id, emoji: r.emoji });
    reactionsByMsg.set(r.message_id, arr);
  }

  const replyIds = Array.from(new Set(finalVisible.map((r: any) => r.reply_to as string).filter(Boolean)));
  let repliedMap = new Map<string, any>();

  if (replyIds.length > 0) {
    const { data: replied } = await supabase
      .from("messages")
      .select("id, content, message_type, media_name, sender_id")
      .in("id", replyIds);
    const repliedList = replied ?? [];
    const senderIds = Array.from(new Set(repliedList.map((r: any) => r.sender_id as string).filter(Boolean)));
    const { data: senders } = await supabase
      .from("profiles")
      .select("id, username, display_name")
      .in("id", senderIds);
    const senderMap = new Map((senders ?? []).map((s: any) => [s.id, s]));
    repliedMap = new Map(
      repliedList.map((m: any) => [
        m.id,
        {
          ...m,
          sender_name:
            senderMap.get(m.sender_id)?.display_name ??
            senderMap.get(m.sender_id)?.username ??
            null,
        },
      ]),
    );
  }

  return finalVisible.map((m: any) => ({
    ...m,
    is_saved: allSavedIds.includes(m.id),
    saved_by_me: mySavedIds.includes(m.id),
    reactions: reactionsByMsg.get(m.id) ?? [],
    replied_message: m.reply_to ? repliedMap.get(m.reply_to) ?? null : null,
    deleted_by_name: m.profiles?.display_name || m.profiles?.username || null,
  }));
}

export const listMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;

    const { data: convResult } = await supabase
      .from("conversations")
      .select("expiry_seconds")
      .eq("id", data.conversationId)
      .maybeSingle();
      // Fetch saved message ids for this conversation so users who saved an expired
      // message still see it in their UI.
      const { data: savedRes } = await supabase.from("message_saves").select("message_id").eq("conversation_id", data.conversationId);
      const savedIds = (savedRes ?? []).map((s: any) => s.message_id as string);

      // Fetch the most recent 1000 non-deleted, non-purged messages (DESC limit then reverse)
      // using the new disappearing system columns (delete_after / deleted_at).
      const nowIso = new Date().toISOString();
      const { data: descRows, error } = await supabase
        .from("messages")
        .select("*, profiles!deleted_by_id(username, display_name)")
        .eq("conversation_id", data.conversationId)
        .is("deleted_at", null)
        .or(`delete_after.is.null,delete_after.gt.${nowIso}`)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw new Error(error.message);

      // Also fetch any messages the user saved (they might be expired).
      let savedRows: any[] = [];
      if (savedIds.length > 0) {
        const { data: sRows } = await supabase
          .from("messages")
          .select("*, profiles!deleted_by_id(username, display_name)")
          .in("id", savedIds)
          .order("created_at", { ascending: false });
        savedRows = sRows ?? [];
      }

      // Merge, dedupe, and reverse to chronological order for display
      const byId = new Map<string, any>();
      for (const r of (descRows ?? [])) byId.set(r.id, r);
      for (const r of savedRows) byId.set(r.id, r);
      const merged = Array.from(byId.values()).slice().reverse();
      return await enrichMessages({ supabase, userId, conversationId: data.conversationId, rows: merged });
  });

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        conversationId: z.string().uuid(),
        replyTo: z.string().uuid().optional(),
        content: z.string().max(4000, "Message cannot exceed 4000 characters").optional(),
        media: z
          .object({
            path: z.string(),
            mime: z.string(),
            name: z.string(),
            size: z.number().int().nonnegative(),
            kind: messageKind,
          })
          .optional(),
      })
      .refine((v) => (v.content && v.content.trim().length > 0) || v.media, {
        message: "Empty message",
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: row, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: data.conversationId,
        sender_id: userId,
        content: data.content?.trim() || null,
        reply_to: data.replyTo ?? null,
        media_path: data.media?.path ?? null,
        media_mime: data.media?.mime ?? null,
        media_name: data.media?.name ?? null,
        media_size: data.media?.size ?? null,
        message_type: data.media?.kind ?? "text",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    // Enrich with replied_message so the sender sees the reply preview immediately
    let repliedMessage: any = null;
    if (row.reply_to) {
      const { data: refMsg } = await supabase
        .from("messages")
        .select("id, content, message_type, media_name, sender_id")
        .eq("id", row.reply_to)
        .maybeSingle();
      if (refMsg) {
        const { data: senderProf } = await supabase
          .from("profiles")
          .select("username, display_name")
          .eq("id", refMsg.sender_id)
          .maybeSingle();
        repliedMessage = {
          ...refMsg,
          sender_name: senderProf?.display_name ?? senderProf?.username ?? null,
        };
      }
    }

    return { ...row, replied_message: repliedMessage };
  });

export const getMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ messageId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    const nowIso = new Date().toISOString();

    const { data: row, error } = await supabase
      .from("messages")
      .select("*, profiles!deleted_by_id(username, display_name)")
      .eq("id", data.messageId)
      .is("deleted_at", null)
      .or(`delete_after.is.null,delete_after.gt.${nowIso}`)
      .maybeSingle();

    if (error) throw new Error(error.message);
    // If the message wasn't returned due to expiry, allow it if the user saved it.
    if (!row) {
      const { data: saved } = await supabase
        .from("message_saves")
        .select("message_id")
        .eq("message_id", data.messageId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!saved) return null;

      const { data: row2, error: err2 } = await supabase
        .from("messages")
        .select("*, profiles!deleted_by_id(username, display_name)")
        .eq("id", data.messageId)
        .maybeSingle();
      if (err2) throw new Error(err2.message);
      if (!row2) return null;
      const enriched2 = await enrichMessages({
        supabase,
        userId,
        conversationId: row2.conversation_id,
        rows: [row2],
      });
      return enriched2[0] ?? null;
    }

    const enriched = await enrichMessages({
      supabase,
      userId,
      conversationId: row.conversation_id,
      rows: [row],
    });

    return enriched[0] ?? null;
  });

export const editMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ id: z.string().uuid(), content: z.string().trim().min(1).max(4000, "Message cannot exceed 4000 characters") }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("messages")
      .update({ content: data.content, edited: true })
      .eq("id", data.id)
      .eq("sender_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid(), messageIds: z.array(z.string().uuid()).optional() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { error } = await supabase.rpc("mark_conversation_read", {
      _conv_id: data.conversationId,
      _viewer_id: userId,
    } as any);
    if (error) throw new Error(error.message);

    return { ok: true };
  });

export function canMarkMessagesSeen() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }

  // Mark messages as seen whenever the chat is not hidden. This keeps the
  // read receipt reliable in the app shell and browser environments where
  // focus may not be reported consistently.
  return document.visibilityState !== "hidden";
}

export async function markConversationSeenIfVisible({
  conversationId,
  messages,
  meId,
  queryClient,
  markRead,
  isConversationActive = true,
}: {
  conversationId: string;
  messages: Array<{ id: string; sender_id: string; seen_at?: string | null }>;
  meId: string;
  queryClient: { setQueryData: (queryKey: unknown, updater: any) => unknown };
  markRead: (args: { data: { conversationId: string; messageIds?: string[] } }) => Promise<any>;
  isConversationActive?: boolean;
}) {
  if (!conversationId || !isConversationActive || !canMarkMessagesSeen()) {
    return false;
  }

  const unreadMessages = (messages ?? []).filter((message) => {
    return message.sender_id !== meId && !message.seen_at;
  });
  if (unreadMessages.length === 0) {
    return false;
  }

  // The chat must already be rendered in the active conversation for this to count as a genuine view.
  const nowString = new Date().toISOString();
  queryClient.setQueryData(["messages", conversationId], (old: any) => {
    if (!Array.isArray(old)) return old;
    return old.map((message: any) => {
      if (message.sender_id === meId || message.seen_at) return message;
      return { ...message, seen_at: nowString };
    });
  });

  await markRead({ data: { conversationId, messageIds: unreadMessages.map((message) => message.id) } });
  return true;
}

const ALLOWED_MIME =
  /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(webm|ogg|mpeg|mp4|aac|m4a)|application\/pdf|application\/zip|text\/.*|application\/(msword|vnd\.openxmlformats-officedocument.*))$/;

export const createMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        conversationId: z.string().uuid(),
        name: z.string().min(1).max(200),
        mime: z.string().min(1).max(120).regex(ALLOWED_MIME, "Unsupported file type"),
        size: z
          .number()
          .int()
          .positive()
          .max(25 * 1024 * 1024),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const ext = data.name.includes(".") ? data.name.split(".").pop() : "bin";
    const path = `${data.conversationId}/${crypto.randomUUID()}.${ext}`;
    const { data: signed, error } = await context.supabase.storage
      .from("chat-media")
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { path, token: signed.token };
  });

export const signedMediaUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ path: z.string().min(1).max(300) }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: signed, error } = await context.supabase.storage
      .from("chat-media")
      .createSignedUrl(data.path, 60 * 60);
    if (error) throw new Error(error.message);
    return { url: signed.signedUrl };
  });

export const saveMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ messageId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("save_message", { _msg_id: data.messageId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unsaveMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ messageId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("unsave_message", { _msg_id: data.messageId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
