import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("message_drafts")
      .select("content, updated_at")
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      content: row?.content ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });

export const saveDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        conversationId: z.string().uuid(),
        content: z.string().max(4000).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (data.content === null || data.content.trim() === "") {
      const { error } = await context.supabase
        .from("message_drafts")
        .delete()
        .eq("conversation_id", data.conversationId)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { ok: true, cleared: true };
    }

    const { error } = await context.supabase
      .from("message_drafts")
      .upsert(
        {
          conversation_id: data.conversationId,
          user_id: context.userId,
          content: data.content,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,conversation_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true, cleared: false };
  });

export const clearDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ conversationId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("message_drafts")
      .delete()
      .eq("conversation_id", data.conversationId)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
