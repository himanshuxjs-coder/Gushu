import { useEffect } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useServerFn } from "@tanstack/react-start";
import { updatePresence } from "@/lib/presence.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext();
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

  return <Outlet />;
}
