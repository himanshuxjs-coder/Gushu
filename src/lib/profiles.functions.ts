import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const searchUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ q: z.string().trim().min(1).max(40) }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const displayTerm = data.q.trim().replace(/\s+/g, " ");
    const usernameTerm = displayTerm.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!displayTerm) return [];

    // Query usernames and display names separately so either field can match.
    const [hiddenResult, usernameResult, displayNameResult] = await Promise.all([
      supabase
        .from("conversation_settings")
        .select("conversation_id")
        .eq("user_id", userId)
        .eq("is_hidden", true)
        .not("secret_code_hash", "is", null),
      usernameTerm
        ? supabase
            .from("profiles")
            .select("id, username, display_name, avatar_url, verified")
            .ilike("username", "%" + usernameTerm + "%")
            .neq("id", userId)
            .limit(25)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, verified")
        .ilike("display_name", "%" + displayTerm + "%")
        .neq("id", userId)
        .limit(25),
    ]);

    if (hiddenResult.error) throw new Error(hiddenResult.error.message);
    if (usernameResult.error) throw new Error(usernameResult.error.message);
    if (displayNameResult.error) throw new Error(displayNameResult.error.message);

    const profilesById = new Map<string, any>();
    for (const profile of [...(usernameResult.data ?? []), ...(displayNameResult.data ?? [])]) {
      if (profile) profilesById.set(profile.id, profile);
    }

    const hiddenSettings = hiddenResult.data;
    let excludeUserIds: string[] = [];
    if (hiddenSettings && hiddenSettings.length > 0) {
      const convIds = hiddenSettings.map((setting) => setting.conversation_id);
      const { data: conversations, error } = await supabase
        .from("conversations")
        .select("user1_id, user2_id")
        .in("id", convIds);
      if (error) throw new Error(error.message);
      if (conversations) {
        excludeUserIds = conversations.map((conversation) =>
          conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id,
        );
      }
    }

    const excluded = new Set(excludeUserIds);
    const normalizedQuery = displayTerm.toLowerCase();
    const normalizedUsernameQuery = usernameTerm;
    const score = (profile: { username: string; display_name: string | null }) => {
      const username = profile.username.toLowerCase();
      const name = (profile.display_name ?? "").toLowerCase();
      if (username === normalizedUsernameQuery) return 0;
      if (normalizedUsernameQuery && username.startsWith(normalizedUsernameQuery)) return 1;
      if (name === normalizedQuery) return 2;
      if (name.startsWith(normalizedQuery)) return 3;
      return 4;
    };

    return [...profilesById.values()]
      .filter((profile) => !excluded.has(profile.id))
      .sort((a, b) => score(a) - score(b))
      .slice(0, 10);
  });

export const getProfileByUsername = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ username: z.string().trim().min(1).max(40) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url, bio, verified, last_seen_at, created_at")
      .eq("username", data.username.toLowerCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });

export const getProfileByUserId = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ userId: z.string().trim().min(1) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url, bio, verified, last_seen_at, created_at")
      .eq("id", data.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        display_name: z.string().trim().max(40).optional(),
        bio: z.string().trim().max(280).optional(),
        avatar_url: z.string().trim().max(300).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("profiles").update(data).eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const heartbeat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase
      .from("profiles")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", context.userId);
    return { ok: true };
  });

export const signedAvatarUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ path: z.string().min(1).max(300) }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: signed, error } = await context.supabase.storage
      .from("avatars")
      .createSignedUrl(data.path, 60 * 60 * 24);
    if (error) throw new Error(error.message);
    return { url: signed.signedUrl };
  });
