import { useEffect } from "react";
import { createFileRoute, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useServerFn } from "@tanstack/react-start";
import { updatePresence } from "@/lib/presence.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // This route is client-only. Use the persisted session and avoid a
    // second remote auth request while navigation is still settling.
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.user) throw redirect({ to: "/auth", replace: true });
    return { user: data.session.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  usePushNotifications(user?.id);
  const updatePresenceFn = useServerFn(updatePresence);

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
