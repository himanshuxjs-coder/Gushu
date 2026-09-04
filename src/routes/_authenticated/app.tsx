import { createFileRoute, Link, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient, useIsFetching } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LogOut, Settings as SettingsIcon, Shield, CircleAlert as AlertCircle, RefreshCw, Loader as Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Logo, Wordmark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar } from "@/components/avatar";
import { UserSearch } from "@/components/user-search";
import { ConversationList } from "@/components/conversation-list";
import { ProfileView } from "@/components/profile-view";
import { Button } from "@/components/ui/button";
import { listMyConversations } from "@/lib/conversations.functions";
import { heartbeat } from "@/lib/profiles.functions";
import { getIncognito } from "@/lib/privacy.functions";
import { amIAdmin } from "@/lib/admin.functions";
import { initializeGlobalNotifications, setActiveConversationId, unregisterPushNotifications } from "@/lib/notification-service";
import { toast } from "sonner";
import { cn, debounceInvalidation } from "@/lib/utils";
import { subscribeWithReconnect } from "@/lib/realtime-utils";

export const Route = createFileRoute("/_authenticated/app")({
  component: AppShell,
});

function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const listFn = useServerFn(listMyConversations);
  const beat = useServerFn(heartbeat);
  const isAdminFn = useServerFn(amIAdmin);
  const getIncognitoFn = useServerFn(getIncognito);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const profileChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const notifCleanupRef = useRef<(() => void) | null>(null);
  const beatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [fullProfile, setFullProfile] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      const u = data.user;
      if (!u) return null;
      const { data: prof } = await supabase
        .from("profiles")
        .select("username, avatar_url, verified")
        .eq("id", u.id)
        .maybeSingle();
      return {
        id: u.id,
        email: u.email ?? null,
        username: prof?.username ?? u.email?.split("@")[0] ?? "you",
        avatar_url: prof?.avatar_url ?? null,
        verified: prof?.verified ?? false,
      };
    },
    staleTime: 60000,
  });

  const openProfile = useCallback(async () => {
    if (!meQuery.data) return;
    setProfileOpen(true);
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, bio, verified, last_seen_at, created_at")
        .eq("id", meQuery.data.id)
        .maybeSingle();
      if (data) setFullProfile(data);
    } catch {}
  }, [meQuery.data]);

  const incognitoQuery = useQuery({
    queryKey: ["incognito"],
    queryFn: () => getIncognitoFn({ data: undefined as any }),
  });

  const me = meQuery.data;
  const location = useLocation();
  const params = useParams({ strict: false }) as { conversationId?: string };
  const hasActiveConversation = !!params.conversationId;

  useEffect(() => {
    const isChatRoute = /^\/app\/c\//.test(location.pathname);
    const match = location.pathname.match(/\/app\/c\/([^/?#]+)/);
    (window as Window & { __GUSHU_CHAT_OPEN__?: boolean }).__GUSHU_CHAT_OPEN__ = isChatRoute;
    setActiveConversationId(match?.[1] ?? null);
    return () => {
      (window as Window & { __GUSHU_CHAT_OPEN__?: boolean }).__GUSHU_CHAT_OPEN__ = false;
      setActiveConversationId(null);
    };
  }, [location.pathname]);

  useEffect(() => {
    if (!me?.id) return;
    notifCleanupRef.current = initializeGlobalNotifications(me.id, () => {
      debounceInvalidation(queryClient, [["conversations"]]);
    });
    return () => {
      if (notifCleanupRef.current) {
        notifCleanupRef.current();
        notifCleanupRef.current = null;
      }
    };
  }, [me?.id]);

  // Presence heartbeat every 30s (was 1s — too aggressive)
  useEffect(() => {
    if (incognitoQuery.data?.incognito) {
      if (beatTimerRef.current) clearInterval(beatTimerRef.current);
      return;
    }
    beat({ data: undefined as any }).catch(() => {});
    beatTimerRef.current = setInterval(() => beat({ data: undefined as any }).catch(() => {}), 30000);
    return () => {
      if (beatTimerRef.current) clearInterval(beatTimerRef.current);
    };
  }, [beat, incognitoQuery.data?.incognito]);

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => listFn({ data: undefined as any }),
    enabled: meQuery.isSuccess && !!me,
    retry: 2,
    staleTime: 3000,
    gcTime: 300000,
    refetchOnWindowFocus: true,
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
  });

  const isAdminQ = useQuery({
    queryKey: ["amIAdmin"],
    queryFn: () => isAdminFn({ data: undefined as any }),
    enabled: !!me,
  });

  const isFetching = useIsFetching() > 0;

  // Single realtime channel for app-level updates
  useEffect(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const ch = supabase
      .channel("app-feed", { config: { broadcast: { self: true } } })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const message = payload.new as any;
        if (!message) return;
        queryClient.setQueryData(["conversations"], (old: any) => {
          if (!Array.isArray(old)) return old;
          return old.map((conv: any) => {
            if (conv.id !== message.conversation_id) return conv;
            return {
              ...conv,
              last: {
                content: message.content,
                message_type: message.message_type,
                created_at: message.created_at,
                sender_id: message.sender_id,
              },
              last_message_at: message.created_at,
              unread: message.sender_id === me?.id ? conv.unread : (conv.unread ?? 0) + 1,
            };
          });
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (payload) => {
        const message = payload.new as any;
        if (!message) return;
        queryClient.setQueryData(["conversations"], (old: any) => {
          if (!Array.isArray(old)) return old;
          return old.map((conv: any) => {
            if (conv.id !== message.conversation_id) return conv;
            if (!conv.last) return conv;
            if (new Date(conv.last.created_at).getTime() < new Date(message.created_at).getTime()) return conv;
            return {
              ...conv,
              last: {
                content: message.content,
                message_type: message.message_type,
                created_at: message.created_at,
                sender_id: message.sender_id,
              },
            };
          });
        });
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, () => {
        // Refresh conversation previews when messages are deleted (e.g. expiry purge)
        debounceInvalidation(queryClient, [["conversations"]], 1000);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, (payload) => {
        const convUpdate = payload.new as any;
        queryClient.setQueryData(["conversations"], (old: any) => {
          if (!Array.isArray(old)) return old;
          return old.map((conv: any) => (conv.id === convUpdate.id ? { ...conv, last_message_at: convUpdate.last_message_at } : conv));
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_settings" }, () => {
        debounceInvalidation(queryClient, [["conversations"]], 500);
      });

    subscribeWithReconnect(ch);
    channelRef.current = ch;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [queryClient, me?.id]);

  // Realtime profile updates for conversation list (online/offline/last-seen, display_name, avatar)
  useEffect(() => {
    if (profileChannelRef.current) {
      supabase.removeChannel(profileChannelRef.current);
      profileChannelRef.current = null;
    }
    const ch = supabase
      .channel("profiles-feed")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, (payload) => {
        const prof = payload.new as any;
        queryClient.setQueryData(["conversations"], (old: any) => {
          if (!Array.isArray(old)) return old;
          return old.map((conv: any) =>
            conv.other?.id === prof.id
              ? { ...conv, other: { ...conv.other, ...prof } }
              : conv,
          );
        });
      });

    subscribeWithReconnect(ch);
    profileChannelRef.current = ch;
    return () => {
      if (profileChannelRef.current) {
        supabase.removeChannel(profileChannelRef.current);
        profileChannelRef.current = null;
      }
    };
  }, [queryClient]);

  useEffect(() => {
    const totalUnread = (conversations.data ?? [])
      .filter((c: any) => !c.hidden)
      .reduce((n: number, c: any) => n + c.unread, 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) Gushu` : "Gushu";
  }, [conversations.data]);

  async function refreshConversations() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.refetchQueries({ queryKey: ["conversations"] });
      await queryClient.refetchQueries({ queryKey: ["me"] });
      toast.success("Conversations refreshed");
    } catch {
      toast.error("Failed to refresh conversations");
    } finally {
      setRefreshing(false);
    }
  }

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await unregisterPushNotifications();
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-border bg-card transition-all duration-300 ease-in-out",
          "fixed inset-y-0 left-0 z-20 w-full md:relative md:w-80",
          hasActiveConversation ? "-translate-x-full md:translate-x-0" : "translate-x-0",
        )}
      >
        <div className="border-b border-border p-5">
          <div className="mb-5 flex items-center justify-between">
            <Link to="/app" className="flex items-center gap-2">
              <Logo size={28} />
              <Wordmark className="text-xl text-foreground" />
            </Link>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={refreshing ? "Refreshing chats" : "Refresh chats"}
                onClick={() => {
                  void refreshConversations();
                }}
                disabled={refreshing}
                className={cn(
                  "relative overflow-hidden rounded-xl border border-white/10 bg-white/5 text-muted-foreground transition-all duration-300 hover:border-white/20 hover:bg-white/10 hover:text-foreground active:scale-95",
                  refreshing && "cursor-wait border-amber-400/30 bg-amber-400/10 text-amber-300"
                )}
              >
                <span className={cn("flex items-center justify-center transition-all duration-300", refreshing && "animate-[spin_1s_linear_infinite]")}>
                  {refreshing ? <Loader2 className="size-4" /> : <RefreshCw className="size-4" />}
                </span>
              </Button>
              <ThemeToggle />
              <Link to="/settings">
                <Button variant="ghost" size="icon" aria-label="Settings" className="text-muted-foreground hover:text-foreground hover:bg-muted">
                  <SettingsIcon className="size-4" />
                </Button>
              </Link>
              {isAdminQ.data?.admin && (
                <Link to="/admin">
                  <Button variant="ghost" size="icon" aria-label="Admin" className="text-amber-400 hover:bg-amber-400/10">
                    <Shield className="size-4" />
                  </Button>
                </Link>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                onClick={signOut}
                className="text-red-400 hover:text-red-500 hover:bg-red-500/10 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-110 active:scale-90"
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>
          <UserSearch />
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
          {conversations.isError && (
            <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-red-400">
              <AlertCircle className="size-5" />
              <p>
                Failed to load conversations{conversations.error?.message ? `: ${conversations.error.message}` : ""}
              </p>
              <button
                onClick={() => conversations.refetch()}
                className="text-xs underline underline-offset-2 hover:no-underline"
              >
                Try again
              </button>
            </div>
          )}
          {!conversations.isError && (
            <ConversationList
              items={conversations.data ?? []}
              loading={conversations.isLoading}
              showHidden={false}
            />
          )}
        </nav>

        <div className="border-t border-border bg-card/80 p-4">
          <div className="flex items-center gap-3 cursor-pointer group" onClick={openProfile}>
            <div className="relative">
              <Avatar
                name={me?.username ?? "you"}
                url={me?.avatar_url}
                size={34}
                className="transition-all duration-300 group-hover:ring-2 group-hover:ring-primary/20"
              />
              {incognitoQuery.data?.incognito && (
                <span className="absolute -top-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-background">
                  <span className="text-[9px]">🥷</span>
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                @{me?.username ?? "you"}
              </div>
              <div className="truncate text-[10px] uppercase tracking-widest text-muted-foreground">
                {incognitoQuery.data?.incognito ? "Incognito" : "Online"}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main
        className={cn(
          "relative flex min-h-0 flex-col bg-background transition-all duration-300 ease-in-out",
          "fixed inset-0 z-10 w-full md:relative md:flex-1",
          hasActiveConversation ? "translate-x-0" : "translate-x-full md:translate-x-0",
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center">
          <div
            className={cn(
              "pointer-events-none mt-4 flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/95 px-4 py-2 text-xs text-white shadow-xl backdrop-blur-xl transition-all duration-300",
              isFetching ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"
            )}
          >
            <Loader2 className="size-4 animate-spin text-white" />
            <span>Refreshing…</span>
          </div>
        </div>
        <Outlet />
      </main>

      {fullProfile && (
        <ProfileView user={fullProfile} open={profileOpen} onOpenChange={setProfileOpen} meId={me?.id} />
      )}
    </div>
  );
}
