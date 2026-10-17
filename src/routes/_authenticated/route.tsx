import { useEffect } from "react";
import { createFileRoute, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { initializePushNotifications } from "@/lib/notification-service";
import { useServerFn } from "@tanstack/react-start";
import { markPresenceInactive, updatePresence } from "@/lib/presence.functions";
import { flushPendingTextMessages } from "@/lib/message-outbox";
import { writeCachedMessages, type LocalChatMessage } from "@/lib/local-chat-cache";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.user) {
      throw redirect({ to: "/auth", replace: true });
    }

    const user = sessionData.session.user;

    if (navigator.onLine) {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", user.id)
        .maybeSingle();
      if (!profileError && !profile) {
        await supabase.auth.signOut({ scope: "local" });
        throw redirect({ to: "/auth", replace: true });
      }
    }

    return { user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const updatePresenceFn = useServerFn(updatePresence);
  const markPresenceInactiveFn = useServerFn(markPresenceInactive);

  useEffect(() => {
    let flushing = false;
    const flush = async () => {
      if (flushing || !navigator.onLine) return;
      flushing = true;
      try {
        const { sent, failedIds } = await flushPendingTextMessages(user.id);
        for (const message of sent) {
          const queryKey = ["messages", message.conversation_id];
          const updated = queryClient.setQueryData<LocalChatMessage[]>(queryKey, (current) => {
            const list = current ?? [];
            const index = list.findIndex((item) => item.id === message.id);
            if (index < 0) return [...list, { ...message, is_optimistic: false }];
            return list.map((item) => item.id === message.id
              ? { ...item, ...message, is_optimistic: false, send_failed: false }
              : item);
          });
          if (Array.isArray(updated)) {
            void writeCachedMessages(user.id, message.conversation_id, updated).catch(() => {});
          }
        }
        for (const id of failedIds) {
          for (const [queryKey, current] of queryClient.getQueriesData<LocalChatMessage[]>({
            queryKey: ["messages"],
          })) {
            if (!current?.some((message) => message.id === id)) continue;
            queryClient.setQueryData(
              queryKey,
              current.map((message) => message.id === id
                ? { ...message, is_optimistic: false, send_failed: true }
                : message),
            );
          }
        }
      } finally {
        flushing = false;
      }
    };

    const handleOnline = () => {
      void flush();
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["conv-settings"] });
    };

    void flush();
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [queryClient, user.id]);

  useEffect(() => {
    initializePushNotifications(user.id);
  }, [user.id]);

  // Heartbeat: update last_seen_at every 30s and on tab focus/visibility.
  // This drives the "Online" / "Last seen" indicator for other users.
  useEffect(() => {
    if (!user?.id) return;

    const beat = () => {
      void updatePresenceFn({ data: {} }).catch(() => {});
    };

    beat();

    const intervalId = setInterval(beat, 30_000);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        beat();
      } else {
        void markPresenceInactiveFn({ data: undefined });
      }
    };
    const onFocus = () => beat();
    const onPageHide = () => {
      void markPresenceInactiveFn({ data: undefined });
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [markPresenceInactiveFn, updatePresenceFn, user?.id]);

  useEffect(() => {
    const resumeApp = () => {
      if (document.visibilityState !== "visible") return;
      void router.invalidate();
      void queryClient.invalidateQueries({ type: "active" });
    };

    document.addEventListener("visibilitychange", resumeApp);
    window.addEventListener("focus", resumeApp);
    return () => {
      document.removeEventListener("visibilitychange", resumeApp);
      window.removeEventListener("focus", resumeApp);
    };
  }, [queryClient, router]);

  return <Outlet />;
}
