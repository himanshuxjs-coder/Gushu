import { useEffect } from "react";
import { createFileRoute, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { initializePushNotifications } from "@/lib/notification-service";
import { useServerFn } from "@tanstack/react-start";
import { updatePresence } from "@/lib/presence.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.user) {
      throw redirect({ to: "/auth", replace: true });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      await supabase.auth.signOut({ scope: "local" });
      throw redirect({ to: "/auth", replace: true });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!profileError && !profile) {
      await supabase.auth.signOut({ scope: "local" });
      throw redirect({ to: "/auth", replace: true });
    }

    return { user: userData.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const updatePresenceFn = useServerFn(updatePresence);

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
      if (document.visibilityState === "visible") beat();
    };
    const onFocus = () => beat();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [user?.id, updatePresenceFn]);

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
