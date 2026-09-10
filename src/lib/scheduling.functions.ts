import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const scheduledInput = z.object({
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
  scheduledFor: z.string().datetime({ offset: true }),
});

async function assertConversationMember(supabase: any, conversationId: string, userId: string) {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Conversation unavailable");
}

function assertFuture(scheduledFor: string) {
  const timestamp = new Date(scheduledFor).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error("Choose a time in the future");
  }
  if (timestamp > Date.now() + 366 * 24 * 60 * 60 * 1000) {
    throw new Error("Scheduled messages can be up to one year ahead");
  }
}

export const listScheduledMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertConversationMember(context.supabase, data.conversationId, context.userId);
    const { data: rows, error } = await context.supabase
      .from("scheduled_messages")
      .select("id, conversation_id, content, scheduled_for, status, created_at, updated_at")
      .eq("conversation_id", data.conversationId)
      .eq("sender_id", context.userId)
      .eq("status", "pending")
      .order("scheduled_for", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => scheduledInput.parse(input))
  .handler(async ({ data, context }) => {
    assertFuture(data.scheduledFor);
    await assertConversationMember(context.supabase, data.conversationId, context.userId);
    const { data: row, error } = await context.supabase
      .from("scheduled_messages")
      .insert({
        conversation_id: data.conversationId,
        sender_id: context.userId,
        content: data.content,
        scheduled_for: data.scheduledFor,
      })
      .select("id, conversation_id, content, scheduled_for, status, created_at, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({
      id: z.string().uuid(),
      content: z.string().trim().min(1).max(4000),
      scheduledFor: z.string().datetime({ offset: true }),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    assertFuture(data.scheduledFor);
    const { data: existing, error: existingError } = await context.supabase
      .from("scheduled_messages")
      .select("conversation_id")
      .eq("id", data.id)
      .eq("sender_id", context.userId)
      .eq("status", "pending")
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (!existing) throw new Error("Scheduled message is no longer pending");
    const { data: row, error } = await context.supabase
      .from("scheduled_messages")
      .update({ content: data.content, scheduled_for: data.scheduledFor, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("sender_id", context.userId)
      .eq("status", "pending")
      .select("id, conversation_id, content, scheduled_for, status, created_at, updated_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Scheduled message is no longer pending");
    return row;
  });

export const cancelScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("scheduled_messages")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("sender_id", context.userId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Scheduled message is no longer pending");
    return { ok: true };
  });
