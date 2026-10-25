import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getConversation } from "@/lib/conversations.functions";
import { getMessage, listMessages, markConversationSeenIfVisible, markRead } from "@/lib/messages.functions";
import { getConversationSettings, verifyConversationSecretCode } from "@/lib/conversation-settings.functions";
import { ChatHeader } from "@/components/chat-header";
import { MessageBubble } from "@/components/message-bubble";
import { DraftBubble, TypingBubble } from "@/components/typing-indicator";
import { Composer } from "@/components/composer";
import { PinDialog } from "@/components/pin-dialog";
import { SecretCodeDialog } from "@/components/secret-code-dialog";
import { DateSeparator, shouldShowSeparator } from "@/components/date-separator";
import { expireMessage } from "@/lib/message-delete.functions";
import { ArrowDown, Loader as Loader2, CircleAlert as AlertCircle, Lock, KeyRound } from "lucide-react";
import { cn, mergeRealtimeMessage, mergeMessages } from "@/lib/utils";
import { subscribeWithReconnect } from "@/lib/realtime-utils";
import { useHiddenStore } from "@/lib/hidden-store";
import { useIsMobile } from "@/hooks/use-mobile";
import { useRemoteViewingPresence } from "@/hooks/use-remote-viewing-presence";
import { ActivityIndicator } from "@/components/activity-indicator";
import { verifyConversationPin } from "@/lib/conversation-settings.functions";
import { toast } from "sonner";
import {
  readCachedMessages,
  readCachedPrivacySettings,
  writeCachedMessages,
  writeCachedPrivacySettings,
} from "@/lib/local-chat-cache";

export const Route = createFileRoute("/_authenticated/app/c/$conversationId")({
  component: ChatPage,
});

const THEME_BG: Record<string, string> = {
  obsidian: "",
  midnight: "bg-blue-950/30",
  neon: "bg-violet-950/30",
  emerald: "bg-emerald-950/30",
  graphite: "bg-neutral-800/30",
};

const WALLPAPER_STYLE: Record<string, string> = {
  none: "",
  grid: "",
  dots: "",
  waves: "",
  aurora: "",
};

const MESSAGE_PAGE_SIZE = 50;

type NewMessagesSeparatorState = {
  conversationId: string;
  firstMessageId: string;
  lastMessageId: string;
  messageIds: string[];
  seenMessageIds: string[];
  count: number;
};

function newMessagesSeparatorStorageKey(userId: string, conversationId: string) {
  return `gushu:new-messages:${userId}:${conversationId}`;
}

function readNewMessagesSeparator(userId: string, conversationId: string): NewMessagesSeparatorState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(newMessagesSeparatorStorageKey(userId, conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NewMessagesSeparatorState;
    if (
      parsed?.conversationId !== conversationId ||
      !parsed.firstMessageId ||
      !Array.isArray(parsed.messageIds) ||
      !Array.isArray(parsed.seenMessageIds)
    ) return null;
    if (parsed.messageIds.length > 0 && parsed.messageIds.every((id) => parsed.seenMessageIds.includes(id))) {
      return null;
    }
    return { ...parsed, count: parsed.messageIds.length };
  } catch {
    return null;
  }
}

function ChatPage() {
  const { conversationId } = Route.useParams();
  const location = useLocation();
  const { user } = Route.useRouteContext();
  const meId = user.id;
  const currentUserVerified = useQuery({
    queryKey: ["me"],
    staleTime: 60000,
  });
  const getConv = useServerFn(getConversation);
  const listMsgs = useServerFn(listMessages);
  const getMsg = useServerFn(getMessage);
  const mark = useServerFn(markRead);
  const expireMsg = useServerFn(expireMessage);
  const getSettings = useServerFn(getConversationSettings);
  const verifyPin = useServerFn(verifyConversationPin);
  const verifySecret = useServerFn(verifyConversationSecretCode);
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [showJumpToLatestButton, setShowJumpToLatestButton] = useState(false);
  const [unreadBelowScroll, setUnreadBelowScroll] = useState(0);
  const initialScrollDoneRef = useRef(false);
  const entryBoundaryFetchRef = useRef<string | null>(null);
  const focusScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const scrollingToEndOnFocusRef = useRef(false);
  const isAnimatingScrollRef = useRef(false);
  const userScrolledUpRef = useRef(false); // Track if user intentionally scrolled up
  const lastScrollTopRef = useRef(0);
  const isNearBottomRef = useRef(true);
  const [isTyping, setIsTyping] = useState(false);
  const [otherUserDraft, setOtherUserDraft] = useState<string | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [replyTarget, setReplyTarget] = useState<any | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isSecretUnlocked, setIsSecretUnlocked] = useState(false);
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [showSecretPrompt, setShowSecretPrompt] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const hiddenSinceRef = useRef<number | null>(null);
  const isMobile = useIsMobile();
  const isUnlockedGlobally = useHiddenStore((s: any) => s.isUnlocked(conversationId));
  const unlockGlobally = useHiddenStore((s: any) => s.unlock);
  const realtimeRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollUpdateFrameRef = useRef<number | null>(null);
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markReadRef = useRef(false);
  const markReadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markReadCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialMessagesLoadedRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(MESSAGE_PAGE_SIZE);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshingOnEntry, setRefreshingOnEntry] = useState(true);
  const [showWeakConnection, setShowWeakConnection] = useState(false);
  const [newMessagesSeparator, setNewMessagesSeparator] = useState<NewMessagesSeparatorState | null>(
    () => readNewMessagesSeparator(meId, conversationId),
  );
  const previousSeparatorRef = useRef<NewMessagesSeparatorState | null>(
    readNewMessagesSeparator(meId, conversationId),
  );
  const activeNewMessagesSeparator =
    newMessagesSeparator?.conversationId === conversationId ? newMessagesSeparator : null;
  // Share one incremental catch-up between chat entry and Realtime subscription recovery.
  const syncNewMessagesRef = useRef<(() => void) | null>(null);
  const messageSyncInFlightRef = useRef(false);
  const messageSyncRequestedRef = useRef(false);
  const protectedMessagesPrefetchRef = useRef<any[] | null>(null);

  useEffect(() => {
    protectedMessagesPrefetchRef.current = null;
  }, [conversationId]);

  const conv = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      try {
        return await getConv({ data: { id: conversationId } });
      } catch (error) {
        const cachedConversations = queryClient.getQueryData<any[]>(["conversations"]);
        const cachedConversation = cachedConversations?.find((item) => item.id === conversationId);
        if (cachedConversation) {
          return { id: conversationId, other: cachedConversation.other ?? null };
        }
        throw error;
      }
    },
    staleTime: 30000,
  });

  const settingsQuery = useQuery({
    queryKey: ["conv-settings", conversationId],
    queryFn: async () => {
      // If this chat was previously opened, use cached *locked* state immediately
      // so its PIN/secret-code prompt does not wait for a network round-trip.
      // Cached unlocked state is never trusted to reveal a conversation.
      const cached = await readCachedPrivacySettings(meId, conversationId).catch(() => null);
      if (cached && (cached.is_locked || cached.is_hidden)) {
        queryClient.setQueryData(["conv-settings", conversationId], (current: any) =>
          current && (current.is_locked || current.is_hidden) ? current : cached,
        );
      }
      try {
        const settings = await getSettings({ data: { conversationId } });
        void writeCachedPrivacySettings(meId, conversationId, settings).catch(() => {});
        return settings;
      } catch (error) {
        const cached = await readCachedPrivacySettings(meId, conversationId);
        if (cached) return cached;
        throw error;
      }
    },
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const settings = settingsQuery.data ?? null;
  const isVerified = currentUserVerified.data?.verified ?? false;

  useEffect(() => {
    if (settings?.pin_hash && settings.pin_hash !== "device-locked") {
      void import("bcryptjs").catch(() => {});
    }
  }, [settings?.pin_hash]);

  const isLocked = !!settings?.is_locked && !!settings?.pin_hash && !isUnlocked;
  const isHiddenLocked =
    !!settings?.is_hidden && !!settings?.secret_code_hash && !isSecretUnlocked && !isUnlockedGlobally;

  const hasSeenReceipt = useCallback((message: any) => {
    return Boolean(message?.seen_at || message?.read_at || message?.first_read_at || message?.viewed_at);
  }, []);

  const otherIsViewing = useRemoteViewingPresence(conversationId, meId, conv.data?.other?.id);

  const showNewMessagesSeparator = useCallback((messages: any[]) => {
    const incoming = messages
      .filter((message: any) => message.sender_id !== meId && message.message_type !== "system")
      .sort((a: any, b: any) => {
        const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return timeDiff || String(a.id).localeCompare(String(b.id));
      });
    if (!incoming.length) return;

    // Merge newly discovered messages into the existing unread group. This
    // preserves the original boundary when several catch-ups happen.
    setNewMessagesSeparator((current) => {
      const existing = current?.conversationId === conversationId ? current : null;
      const messageIds = Array.from(new Set([
        ...(existing?.messageIds ?? []),
        ...incoming.map((message: any) => message.id as string),
      ]));
      const seenMessageIds = (existing?.seenMessageIds ?? []).filter((id) => messageIds.includes(id));
      return {
        conversationId,
        firstMessageId: existing?.firstMessageId ?? incoming[0].id,
        lastMessageId: incoming[incoming.length - 1].id,
        messageIds,
        seenMessageIds,
        count: messageIds.length,
      };
    });
  }, [conversationId, meId]);

  // Persist the unread boundary across inbox navigation, route remounts, and
  // refreshes. A completed group removes its stored boundary.
  useEffect(() => {
    if (newMessagesSeparator?.conversationId === conversationId) {
      try {
        window.localStorage.setItem(
          newMessagesSeparatorStorageKey(meId, conversationId),
          JSON.stringify(newMessagesSeparator),
        );
      } catch {}
      previousSeparatorRef.current = newMessagesSeparator;
      return;
    }

    if (previousSeparatorRef.current?.conversationId === conversationId) {
      try {
        window.localStorage.removeItem(newMessagesSeparatorStorageKey(meId, conversationId));
      } catch {}
    }
    previousSeparatorRef.current = null;
  }, [conversationId, meId, newMessagesSeparator]);

  // Restore the correct boundary if the router reuses this component for a
  // different conversation.
  useEffect(() => {
    const restored = readNewMessagesSeparator(meId, conversationId);
    setNewMessagesSeparator(restored);
    previousSeparatorRef.current = restored;
  }, [conversationId, meId]);

  // A message counts as seen only after its bubble was actually visible in the
  // chat viewport. Jumping straight to the end therefore cannot dismiss the
  // separator for messages the user skipped.
  useEffect(() => {
    const separator = activeNewMessagesSeparator;
    const pane = scrollRef.current;
    if (!separator || !pane) return;

    let frame = 0;
    const checkVisibleNewMessages = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const paneRect = pane.getBoundingClientRect();
      const newlySeen: string[] = [];

      for (const id of separator.messageIds) {
        if (separator.seenMessageIds.includes(id)) continue;
        const node = pane.querySelector(`[data-msg-id="${id}"]`) as HTMLElement | null;
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const visibleHeight = Math.max(0, Math.min(rect.bottom, paneRect.bottom) - Math.max(rect.top, paneRect.top));
        const requiredHeight = Math.min(rect.height, pane.clientHeight) * 0.6;
        if (visibleHeight > 0 && visibleHeight >= requiredHeight) newlySeen.push(id);
      }

      if (newlySeen.length) {
        setNewMessagesSeparator((current) => {
          if (!current || current.conversationId !== conversationId) return current;
          const seenMessageIds = Array.from(new Set([...current.seenMessageIds, ...newlySeen]));
          if (current.messageIds.every((id) => seenMessageIds.includes(id))) return null;
          return { ...current, seenMessageIds };
        });
      }
    };

    const scheduleCheck = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(checkVisibleNewMessages);
    };
    pane.addEventListener("scroll", scheduleCheck, { passive: true });
    window.addEventListener("focus", scheduleCheck);
    document.addEventListener("visibilitychange", scheduleCheck);
    scheduleCheck();

    return () => {
      pane.removeEventListener("scroll", scheduleCheck);
      window.removeEventListener("focus", scheduleCheck);
      document.removeEventListener("visibilitychange", scheduleCheck);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [
    activeNewMessagesSeparator?.conversationId,
    activeNewMessagesSeparator?.messageIds.join(","),
    activeNewMessagesSeparator?.seenMessageIds.join(","),
    conversationId,
  ]);

  useEffect(() => {
    if (!settings?.is_locked || !settings.pin_hash || typeof window === "undefined") return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenSinceRef.current = Date.now();
        return;
      }

      const hiddenForMs = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0;
      hiddenSinceRef.current = null;

      if (hiddenForMs >= 60_000) {
        setIsUnlocked(false);
        setShowPinPrompt(true);
      }
    };

    const handlePageHide = () => {
      hiddenSinceRef.current = Date.now();
    };

    const handleFocus = () => {
      const hiddenForMs = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0;
      if (hiddenForMs >= 60_000) {
        setIsUnlocked(false);
        setShowPinPrompt(true);
      }
      hiddenSinceRef.current = null;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("focus", handleFocus);
    };
  }, [settings?.is_locked, settings?.pin_hash]);

  useEffect(() => {
    if (isLocked) {
      setIsUnlocked(false);
      setShowPinPrompt(true);
    }
  }, [isLocked, conversationId]);

  useEffect(() => {
    if (isHiddenLocked) {
      setIsSecretUnlocked(false);
      setShowSecretPrompt(true);
    }
  }, [isHiddenLocked, conversationId]);

  const msgs = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: async () => {
      try {
        if (!navigator.onLine) {
          const cached = await readCachedMessages(meId, conversationId);
          if (cached) {
            queryClient.setQueryData(["messages-pagination", conversationId], {
              hasMoreOlder: cached.length >= MESSAGE_PAGE_SIZE,
              beforeCreatedAt: cached[0]?.created_at ?? null,
              beforeId: cached[0]?.id ?? null,
            });
            return cached;
          }
        }
        const previous = queryClient.getQueryData<any>(["messages", conversationId]) ?? [];
        const isIncremental = previous.length > 0;
        let cursor = isIncremental ? previous[previous.length - 1]?.created_at : undefined;
        let cursorId = isIncremental ? previous[previous.length - 1]?.id : undefined;
        let incoming: any[] = [];
        let page: any;

        // Initial load gets the latest page. Subsequent catch-ups fetch only rows newer
        // than the newest cached message, in small batches, until fully caught up.
        do {
          page = await listMsgs({
            data: {
              conversationId,
              limit: MESSAGE_PAGE_SIZE,
              ...(cursor ? { afterCreatedAt: cursor, ...(cursorId ? { afterId: cursorId } : {}) } : {}),
            },
          });
          incoming = incoming.concat(page.messages);
          if (isIncremental && page.hasMoreOlder && page.nextAfterCreatedAt && page.nextAfterId) {
            cursor = page.nextAfterCreatedAt;
            cursorId = page.nextAfterId;
          } else {
            break;
          }
        } while (true);

        const merged = mergeMessages(previous, incoming);
        if (!isIncremental) {
          queryClient.setQueryData(["messages-pagination", conversationId], {
            hasMoreOlder: page.hasMoreOlder,
            beforeCreatedAt: page.nextBeforeCreatedAt,
            beforeId: page.nextBeforeId,
          });
        }
        await writeCachedMessages(meId, conversationId, merged).catch(() => {});
        return merged;
      } catch (error) {
        console.error("[Gushu] Initial message query failed", { conversationId, error });
        const cached = await readCachedMessages(meId, conversationId);
        if (cached) {
          queryClient.setQueryData(["messages-pagination", conversationId], {
            hasMoreOlder: cached.length >= MESSAGE_PAGE_SIZE,
            beforeCreatedAt: cached[0]?.created_at ?? null,
            beforeId: cached[0]?.id ?? null,
          });
          return cached;
        }
        throw error;
      }
    },
    enabled: settingsQuery.isSuccess && !isLocked && !isHiddenLocked,
    retry: (failureCount) => navigator.onLine && failureCount < 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    staleTime: 15000,
    // Message inserts arrive through Realtime. Catch-up is event-driven (resume/reconnect),
    // not periodic polling.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // On every chat entry—including returning from the chat list—reconcile messages
  // newer than the local cache. Watching the URL also covers routers that retain
  // the route component while navigating between the list and a conversation.
  useEffect(() => {
    // Every return from the inbox is a fresh entry: wait for catch-up, then
    // anchor to the persisted separator again instead of keeping the old scroll.
    initialScrollDoneRef.current = false;
    let cancelled = false;
    setRefreshingOnEntry(true);

    const syncNewMessages = async () => {
      if (messageSyncInFlightRef.current) {
        messageSyncRequestedRef.current = true;
        return;
      }
      messageSyncInFlightRef.current = true;
      try {
        const cached = queryClient.getQueryData<any[]>(["messages", conversationId]) ?? [];
        if (cached.length === 0) {
          // A chat may be opened after navigating away while its query has no
          // in-memory cache. Fetch the latest page directly instead of relying
          // on React Query's stale-only refetch behavior.
          const page = await listMsgs({
            data: { conversationId, limit: MESSAGE_PAGE_SIZE },
          });
          const loaded = mergeMessages([], page.messages);
          if (!cancelled) {
            queryClient.setQueryData(["messages", conversationId], loaded);
            queryClient.setQueryData(["messages-pagination", conversationId], {
              hasMoreOlder: page.hasMoreOlder,
              beforeCreatedAt: page.nextBeforeCreatedAt,
            });
            await writeCachedMessages(meId, conversationId, loaded).catch(() => {});
            const unreadIncoming = loaded.filter((message: any) =>
              message.sender_id !== meId && !hasSeenReceipt(message)
            );
            showNewMessagesSeparator(unreadIncoming);
          }
          return;
        }

        let cursor: string | undefined = cached[cached.length - 1]?.created_at;
        let cursorId: string | undefined = cached[cached.length - 1]?.id;
        const incoming: any[] = [];

        while (cursor && cursorId) {
          const page = await listMsgs({
            data: { conversationId, afterCreatedAt: cursor, afterId: cursorId, limit: MESSAGE_PAGE_SIZE },
          });
          incoming.push(...page.messages);
          if (!page.hasMoreOlder || !page.nextAfterCreatedAt || !page.nextAfterId) break;
          // Advance by the raw server cursor even if enrichment/filtering returns
          // an empty visible page, otherwise a batch could prematurely stop.
          cursor = page.nextAfterCreatedAt;
          cursorId = page.nextAfterId;
        }

        if (!cancelled && incoming.length > 0) {
          const incomingFromOther = incoming.filter((message: any) =>
            message.sender_id !== meId && message.message_type !== "system"
          );
          queryClient.setQueryData<any[]>(["messages", conversationId], (current) =>
            mergeMessages(current ?? cached, incoming),
          );
          if (incomingFromOther.length > 0) {
            setVisibleMessageLimit((limit) => Math.max(limit, cached.length + incoming.length));
            showNewMessagesSeparator(incomingFromOther);
          }
        }
      } catch (error) {
        // Do not silently hide a failed catch-up: that made stale local cache
        // look like a successful sync even after the user manually refreshed.
        console.error("[Gushu] Missed-message catch-up failed", { conversationId, error });
        try {
          // Recovery path: at least reconcile the latest server page if the
          // incremental cursor request fails. Existing messages are preserved.
          const fallbackPage = await listMsgs({
            data: { conversationId, limit: MESSAGE_PAGE_SIZE },
          });
          if (!cancelled) {
            const current = queryClient.getQueryData<any[]>(["messages", conversationId]) ?? [];
            const fallbackIncoming = fallbackPage.messages.filter(
              (message: any) => !current.some((cachedMessage: any) => cachedMessage.id === message.id),
            );
            queryClient.setQueryData<any[]>(["messages", conversationId], mergeMessages(current, fallbackPage.messages));
            await writeCachedMessages(meId, conversationId, mergeMessages(current, fallbackPage.messages)).catch(() => {});
            showNewMessagesSeparator(fallbackIncoming.filter(
              (message: any) => message.sender_id !== meId && message.message_type !== "system",
            ));
          }
        } catch (fallbackError) {
          console.error("[Gushu] Latest-page message recovery also failed", { conversationId, error: fallbackError });
        }
      } finally {
        messageSyncInFlightRef.current = false;
        if (!cancelled) setRefreshingOnEntry(false);
        // If Realtime subscribed while a catch-up was running, run one more
        // incremental pass afterwards to close the fetch/subscribe race.
        if (messageSyncRequestedRef.current) {
          messageSyncRequestedRef.current = false;
          // The route may have changed while the previous request was running;
          // dispatch through the ref so the current conversation gets synced.
          syncNewMessagesRef.current?.();
        }
      }
    };

    const runSync = () => { void syncNewMessages(); };
    syncNewMessagesRef.current = runSync;
    runSync();
    return () => {
      cancelled = true;
      if (syncNewMessagesRef.current === runSync) syncNewMessagesRef.current = null;
    };
  }, [conversationId, hasSeenReceipt, listMsgs, location.pathname, meId, queryClient, showNewMessagesSeparator]);

  // Fetch only missed messages when the app returns or connectivity is restored.
  // No timer/polling: normal incoming messages are inserted by the Realtime callback.
  useEffect(() => {
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    const syncMessagesOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ["messages", conversationId],
          exact: true,
          refetchType: "active",
        });
      }, 150);
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) syncMessagesOnReturn();
    };

    document.addEventListener("visibilitychange", syncMessagesOnReturn);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", syncMessagesOnReturn);
    return () => {
      if (syncTimer) clearTimeout(syncTimer);
      document.removeEventListener("visibilitychange", syncMessagesOnReturn);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", syncMessagesOnReturn);
    };
  }, [conversationId, queryClient]);

  const pagination = useQuery({
    queryKey: ["messages-pagination", conversationId],
    queryFn: async () => ({ hasMoreOlder: false, beforeCreatedAt: null as string | null, beforeId: null as string | null }),
    enabled: false,
  });

  useEffect(() => {
    // Warm the local cache while the PIN/secret-code dialog is open, but keep the
    // messages out of React Query and out of the rendered UI until verification.
    if (!settingsQuery.isSuccess || (!isLocked && !isHiddenLocked)) return;
    let cancelled = false;
    void readCachedMessages(meId, conversationId)
      .then((cachedMessages) => {
        if (!cancelled) protectedMessagesPrefetchRef.current = cachedMessages;
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conversationId, isHiddenLocked, isLocked, meId, settingsQuery.isSuccess]);

  useEffect(() => {
    // Do not hydrate protected message content into the active query cache until
    // the current privacy gate has been resolved and any required unlock succeeds.
    if (!settingsQuery.isSuccess || isLocked || isHiddenLocked) return;
    let cancelled = false;
    void readCachedMessages(meId, conversationId)
      .then((cachedMessages) => {
        if (cancelled || !cachedMessages?.length) return;
        queryClient.setQueryData<any[]>(["messages", conversationId], (current) =>
          current?.length ? current : cachedMessages,
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [conversationId, isHiddenLocked, isLocked, meId, queryClient, settingsQuery.isSuccess]);

  useEffect(() => {
    if (!Array.isArray(msgs.data)) return;
    const timeoutId = window.setTimeout(() => {
      void writeCachedMessages(meId, conversationId, msgs.data ?? []).catch(() => {});
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [conversationId, meId, msgs.data]);

  // Keep filtering and expiry checks out of unrelated renders such as typing,
  // presence, and scroll updates. The browser skips painting offscreen rows.
  const allVisibleMessages = useMemo(() => {
    const now = Date.now();
    return (msgs.data ?? []).filter((message: any) => {
      if (message.is_saved) return true;
      if (!message.expires_at) return true;
      return new Date(message.expires_at).getTime() > now;
    });
  }, [msgs.data]);

  const visibleMessages = useMemo(
    () => allVisibleMessages.slice(-visibleMessageLimit),
    [allVisibleMessages, visibleMessageLimit],
  );

  useLayoutEffect(() => {
    const previous = preserveScrollRef.current;
    const element = scrollRef.current;
    if (!previous || !element) return;
    element.scrollTop = previous.top + element.scrollHeight - previous.height;
    preserveScrollRef.current = null;
  }, [msgs.data, visibleMessages]);

  const loadEarlierMessages = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const element = scrollRef.current;
    if (!element) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    preserveScrollRef.current = { height: element.scrollHeight, top: element.scrollTop };

    try {
      const current = queryClient.getQueryData<any[]>(["messages", conversationId]) ?? [];
      if (visibleMessageLimit < current.length) {
        setVisibleMessageLimit((limit) => limit + MESSAGE_PAGE_SIZE);
        return;
      }

      let beforeCreatedAt = pagination.data?.beforeCreatedAt ?? current[0]?.created_at;
      let beforeId = pagination.data?.beforeId ?? current[0]?.id;
      if (!beforeCreatedAt || !pagination.data?.hasMoreOlder) {
        preserveScrollRef.current = null;
        return;
      }

      // Expired messages are filtered by the server after paging. Keep advancing
      // the raw keyset cursor until a page contains visible messages or history ends.
      let page: any;
      do {
        page = await listMsgs({
          data: {
            conversationId,
            beforeCreatedAt,
            ...(beforeId ? { beforeId } : {}),
            limit: MESSAGE_PAGE_SIZE,
          },
        });

        queryClient.setQueryData(["messages-pagination", conversationId], {
          hasMoreOlder: page.hasMoreOlder,
          beforeCreatedAt: page.nextBeforeCreatedAt,
          beforeId: page.nextBeforeId,
        });

        if (page.messages.length > 0) {
          queryClient.setQueryData<any[]>(["messages", conversationId], (old) =>
            mergeMessages(old ?? [], page.messages),
          );
          setVisibleMessageLimit((limit) => limit + MESSAGE_PAGE_SIZE);
          break;
        }

        beforeCreatedAt = page.nextBeforeCreatedAt;
        beforeId = page.nextBeforeId;
        if (!page.hasMoreOlder || !beforeCreatedAt || !beforeId) break;
      } while (true);
    } catch {
      preserveScrollRef.current = null;
      toast.error("Could not load earlier messages");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [conversationId, listMsgs, pagination.data, queryClient, visibleMessageLimit]);

  useEffect(() => {
    setVisibleMessageLimit(MESSAGE_PAGE_SIZE);
    loadingOlderRef.current = false;
    preserveScrollRef.current = null;
    initialScrollDoneRef.current = false;
  }, [conversationId]);

  const unreadMessages = useMemo(
    () => (msgs.data ?? []).filter((message: any) => message.sender_id !== meId && !hasSeenReceipt(message)),
    [hasSeenReceipt, meId, msgs.data],
  );

  const unreadMessageCount = unreadMessages.length;

  const isChatActuallyViewed = useCallback(() => {
    const el = scrollRef.current;
    if (!el || typeof document === "undefined" || document.visibilityState !== "visible" || !document.hasFocus()) {
      return false;
    }

    const paneRect = el.getBoundingClientRect();
    const paneIsVisible = paneRect.bottom > 0 && paneRect.top < window.innerHeight;
    if (!paneIsVisible) return false;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottomThreshold = isMobile ? 50 : 120;
    if (distanceFromBottom < nearBottomThreshold) return true;

    const firstUnread = msgs.data?.find(
      (message: any) => message.sender_id !== meId && !hasSeenReceipt(message),
    );
    if (!firstUnread) return false;

    const messageEl = el.querySelector(`[data-msg-id="${firstUnread.id}"]`);
    if (!messageEl) return false;
    const messageRect = messageEl.getBoundingClientRect();
    return messageRect.bottom > paneRect.top && messageRect.top < paneRect.bottom;
  }, [hasSeenReceipt, isMobile, meId, msgs.data]);

  useEffect(() => {
    if (!conversationId) return;

    const markActive = async () => {
      if (typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus())) {
        await supabase.rpc("mark_conversation_inactive", {
          p_conversation_id: conversationId,
        });
        return;
      }
      await supabase.rpc("mark_conversation_active", {
        p_conversation_id: conversationId,
      });
    };

    const handleVisibilityChange = () => {
      void markActive();
    };

    const handleFocusChange = () => {
      void markActive();
    };

    // Immediately mark active when the chat is visible, and keep presence alive
    // gradually without flooding the network on hidden tabs.
    void markActive();
    presenceTimerRef.current = setInterval(markActive, 60000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocusChange);
    window.addEventListener("blur", handleFocusChange);
    window.addEventListener("pageshow", handleFocusChange);
    window.addEventListener("pagehide", handleFocusChange);

    return async () => {
      if (presenceTimerRef.current) {
        clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }

      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocusChange);
      window.removeEventListener("blur", handleFocusChange);
      window.removeEventListener("pageshow", handleFocusChange);
      window.removeEventListener("pagehide", handleFocusChange);
      await supabase.rpc("mark_conversation_inactive", {
        p_conversation_id: conversationId,
      });
    };
  }, [conversationId]);

  // Realtime subscription — handles messages, settings, deletions, reactions, saves, profiles
  useEffect(() => {
    if (!conversationId) return;
    if (realtimeRef.current) {
      supabase.removeChannel(realtimeRef.current);
      realtimeRef.current = null;
    }

    const otherId = conv.data?.other?.id;

    const ch = supabase
      .channel(`chat:${conversationId}`, { config: { broadcast: { self: true } } })
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        async (payload) => {
          let msg = payload.new as any;
          if (!msg) return;

          // Live inserts are merged directly. Catch-up runs on initial subscribe
          // and reconnect; querying the server for every live message adds avoidable
          // network work and can make the message list feel sluggish.
          // Enrich replied_message from cache if present
          if (msg.reply_to) {
            const cached = queryClient.getQueryData<any>(["messages", conversationId]) ?? [];
            const ref = cached.find((r: any) => r.id === msg.reply_to);
            if (ref) {
              msg = {
                ...msg,
                replied_message: {
                  id: ref.id,
                  content: ref.content ?? null,
                  message_type: ref.message_type,
                  media_name: ref.media_name ?? null,
                  sender_id: ref.sender_id ?? null,
                  sender_name: ref.replied_message?.sender_name ?? null,
                },
              };
            }
          }

          // Merge into cache — never replace the array
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            return mergeRealtimeMessage(old ?? [], msg);
          });

          // Update conversation list preview + unread
          queryClient.setQueryData(["conversations"], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.map((c: any) =>
              c.id === conversationId
                ? {
                  ...c,
                  last: { content: msg.content, message_type: msg.message_type, created_at: msg.created_at, sender_id: msg.sender_id },
                  last_message_at: msg.created_at,
                  // The app-level Realtime channel owns unread increments. Updating here too
                  // would count the same incoming message twice while this chat is open.
                  unread: c.unread,
                }
                : c,
            );
          });

          // The message-list effect handles follow-to-latest after React commits
          // the new row. Avoid starting duplicate scroll animations here.
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const msg = payload.new as any;
          if (!msg) return;

          // MERGE: only update the matching message, never replace the array.
          // Do NOT invalidateQueries — that triggers a refetch that can lose
          // newer messages and optimistic entries.
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            if (!Array.isArray(old)) return old;
            // If message exists, update in place
            if (old.some((item: any) => item.id === msg.id)) {
              return old.map((item: any) =>
                item.id === msg.id ? { ...item, ...msg } : item,
              );
            }
            // If not found, merge it in (don't refetch)
            return mergeRealtimeMessage(old, msg);
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const msg = payload.old as any;
          if (!msg) return;
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.filter((item) => item.id !== msg.id);
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_reactions" },
        async (payload) => {
          const row = (payload.new ?? payload.old) as any;
          if (!row) return;
          // Refetch reactions for the message by invalidating messages query (lightweight)
          const cached = queryClient.getQueryData<any>(["messages", conversationId]) ?? [];
          if (!cached.some((m: any) => m.id === row.message_id)) return;
          // Update reactions for that message by reading from server is heavy; do a targeted local update
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.map((m: any) => {
              if (m.id !== row.message_id) return m;
              let reactions = m.reactions ?? [];
              if (payload.eventType === "DELETE") {
                reactions = reactions.filter((r: any) => !(r.user_id === row.user_id && r.message_id === row.message_id));
              } else {
                reactions = [...reactions.filter((r: any) => r.user_id !== row.user_id), { user_id: row.user_id, emoji: row.emoji }];
              }
              return { ...m, reactions };
            });
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_saves" },
        (payload) => {
          const row = (payload.new ?? payload.old) as any;
          if (!row || row.conversation_id !== conversationId) return;
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.map((m: any) => {
              if (m.id !== row.message_id) return m;
              const isSaved = payload.eventType !== "DELETE";
              return { ...m, is_saved: isSaved, saved_by_me: isSaved && row.user_id === meId };
            });
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_deletions" },
        (payload) => {
          const row = (payload.new ?? payload.old) as any;
          if (!row || row.user_id !== meId || !row.message_id) return;
          if (row.deleted_for_all) return; // handled by message UPDATE
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.filter((item) => item.id !== row.message_id);
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_settings", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const newSettings = payload.new as any;
          // Only update settings from THIS user's row to avoid cross-user contamination
          if (newSettings?.user_id && newSettings.user_id !== meId) return;
          queryClient.setQueryData(["conv-settings", conversationId], (old: any) => ({ ...old, ...newSettings }));
          // Only refetch messages when cleared_at changes AND it's newer than what we have.
          // Use a targeted merge instead of invalidating to avoid losing newer messages.
          const oldCleared = (payload.old as any)?.cleared_at ?? null;
          const newCleared = newSettings?.cleared_at ?? null;
          if (oldCleared !== newCleared && newCleared) {
            // Filter out cleared (older, unsaved) messages locally — don't refetch
            queryClient.setQueryData(["messages", conversationId], (old: any) => {
              if (!Array.isArray(old)) return old;
              const cutOff = new Date(newCleared).getTime();
              return old.filter((msg: any) => {
                const isOlderThanClear = new Date(msg.created_at).getTime() <= cutOff;
                if (!isOlderThanClear) return true;
                return msg.is_saved === true || msg.saved_by_me === true;
              });
            });
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conversationId}` },
        (payload) => {
          const c = payload.new as any;
          queryClient.setQueryData(["conversations"], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.map((conv: any) => (conv.id === conversationId ? { ...conv, ...c } : conv));
          });
        },
      );

    subscribeWithReconnect(
      ch,
      () => {
        // Reconcile only messages newer than the local cursor after a reconnect.
        syncNewMessagesRef.current?.();
        void queryClient.invalidateQueries({
          queryKey: ["conversations"],
          exact: true,
        });
      },
      () => {
        // Run a second incremental pass after the initial subscription is ready.
        // This closes the gap if a message arrived while the entry fetch was in flight.
        syncNewMessagesRef.current?.();
      },
    );
    realtimeRef.current = ch;

    // Separate channel for profile updates (other user's online/last-seen)
    let profileChannel: ReturnType<typeof supabase.channel> | null = null;
    if (otherId) {
      profileChannel = supabase
        .channel(`profile:${otherId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${otherId}` },
          (payload) => {
            queryClient.setQueryData(["conversation", conversationId], (old: any) => {
              if (!old) return old;
              return { ...old, other: { ...old.other, ...(payload.new as any) } };
            });
            queryClient.setQueryData(["conversations"], (old: any) => {
              if (!Array.isArray(old)) return old;
              return old.map((conv: any) =>
                conv.id === conversationId
                  ? { ...conv, other: { ...conv.other, ...(payload.new as any) } }
                  : conv,
              );
            });
          },
        );

      subscribeWithReconnect(profileChannel);

      // Presence/profile changes are delivered through Realtime; avoid a
      // repeating profile query while the conversation remains open.
    }

    return () => {
      if (realtimeRef.current) {
        supabase.removeChannel(realtimeRef.current);
        realtimeRef.current = null;
      }
      if (profileChannel) {
        supabase.removeChannel(profileChannel);
        profileChannel = null;
      }
    };
  }, [conversationId, queryClient, meId, conv.data?.other?.id]);

  // Live Draft Preview: enabled for all authenticated users (no verified restriction)
  const otherUserId = conv.data?.other?.id;
  const draftPreviewEnabled = true;

  // Clear draft when navigating away or component unmounts
  useEffect(() => {
    return () => {
      setOtherUserDraft(null);
    };
  }, []);

  const markSeenNow = useCallback(async () => {
    if (!conversationId || !msgs.data?.length || isLocked || isHiddenLocked) return;
    const unread = msgs.data.filter((msg: any) => msg.sender_id !== meId && !hasSeenReceipt(msg));
    if (!unread.length) return;

    const nowString = new Date().toISOString();
    queryClient.setQueryData(["messages", conversationId], (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((message: any) => {
        if (message.sender_id === meId) return message;
        const hasReceipt = Boolean(message.seen_at || message.read_at || message.first_read_at || message.viewed_at);
        if (hasReceipt) return message;
        return {
          ...message,
          seen_at: nowString,
          first_read_at: message.first_read_at ?? nowString,
          read_at: message.read_at ?? nowString,
          viewed_at: message.viewed_at ?? nowString,
        };
      });
    });

    try {
      await mark({ data: { conversationId } });
    } catch { }
  }, [conversationId, msgs.data, isLocked, isHiddenLocked, meId, queryClient, hasSeenReceipt, mark]);

  // Mark messages as seen immediately while the active chat is visible.
  // This must happen on route entry and on focus/visibility changes, not only after a refresh cycle.
  useEffect(() => {
    if (!conversationId || !msgs.data?.length || isLocked || isHiddenLocked || !isChatActuallyViewed()) {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
        markReadTimeoutRef.current = null;
      }
      return;
    }

    const shouldMark = msgs.data.some((msg: any) => msg.sender_id !== meId && !hasSeenReceipt(msg));
    if (!shouldMark) {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
        markReadTimeoutRef.current = null;
      }
      return;
    }

    if (markReadTimeoutRef.current) {
      clearTimeout(markReadTimeoutRef.current);
    }

    markReadTimeoutRef.current = setTimeout(() => {
      if (markReadRef.current) return;
      markReadRef.current = true;
      void markSeenNow();

      if (markReadCooldownRef.current) {
        clearTimeout(markReadCooldownRef.current);
      }
      markReadCooldownRef.current = setTimeout(() => {
        markReadRef.current = false;
      }, 600);
    }, 80);

    return () => {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
        markReadTimeoutRef.current = null;
      }
    };
  }, [conversationId, msgs.data, isLocked, isHiddenLocked, meId, isChatActuallyViewed, markSeenNow]);

  useEffect(() => {
    const refreshVisibleChat = async () => {
      if (!conversationId || document.visibilityState !== "visible" || !document.hasFocus()) {
        return;
      }

      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["messages", conversationId] }),
        queryClient.refetchQueries({ queryKey: ["conversation", conversationId] }),
        queryClient.refetchQueries({ queryKey: ["conv-settings", conversationId] }),
        queryClient.refetchQueries({ queryKey: ["conversations"] }),
      ]);

      if (msgs.data?.length) {
        void markSeenNow();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void refreshVisibleChat();
        if (markReadTimeoutRef.current) {
          clearTimeout(markReadTimeoutRef.current);
        }
        markReadTimeoutRef.current = setTimeout(() => {
          void markSeenNow();
        }, 80);
        initialMessagesLoadedRef.current = true;
      }
    };

    const handleWindowFocus = () => {
      if (!isChatActuallyViewed()) return;
      void refreshVisibleChat();
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
      }
      markReadTimeoutRef.current = setTimeout(() => {
        void markSeenNow();
      }, 80);
      initialMessagesLoadedRef.current = true;
    };

    const handleOnline = () => {
      void refreshVisibleChat();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [conversationId, isChatActuallyViewed, markSeenNow, msgs.data, queryClient]);

  const waitForRender = useCallback(() => {
    return new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "undefined") {
        return setTimeout(resolve, 16);
      }
      requestAnimationFrame(() => resolve());
    });
  }, []);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
    isAnimatingScrollRef.current = false;
  }, []);

  const animateScrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    cancelScrollAnimation();

    // Reset user scroll intent
    userScrolledUpRef.current = false;

    const start = el.scrollTop;
    const target = Math.max(el.scrollHeight - el.clientHeight, 0);
    const distance = target - start;

    if (Math.abs(distance) < 4) {
      el.scrollTo({ top: target, behavior: "auto" });
      setShowJumpToLatestButton(false);
      return;
    }

    isAnimatingScrollRef.current = true;

    // Keep the jump quick but visibly eased, even for long conversations.
    const duration = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? 1
      : Math.min(560, Math.max(260, Math.abs(distance) * 0.16));
    const startTime = performance.now();
    const ease = (t: number) => t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const step = (now: number) => {
      if (!scrollRef.current) {
        cancelScrollAnimation();
        return;
      }

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = ease(progress);
      const currentTarget = Math.max(scrollRef.current.scrollHeight - scrollRef.current.clientHeight, 0);
      scrollRef.current.scrollTop = start + (currentTarget - start) * eased;

      if (progress < 1) {
        scrollAnimationFrameRef.current = requestAnimationFrame(step);
      } else {
        scrollRef.current.scrollTop = currentTarget;
        cancelScrollAnimation();
        setShowJumpToLatestButton(false);
      }
    };

    scrollAnimationFrameRef.current = requestAnimationFrame(step);
  }, [cancelScrollAnimation]);

  const scrollToBottom = useCallback(() => {
    animateScrollToBottom();
  }, [animateScrollToBottom]);

  const scrollToBottomOnFocus = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    scrollingToEndOnFocusRef.current = true;
    animateScrollToBottom();

    if (focusScrollTimerRef.current) {
      clearTimeout(focusScrollTimerRef.current);
    }

    focusScrollTimerRef.current = setTimeout(() => {
      animateScrollToBottom();
      scrollingToEndOnFocusRef.current = false;
      focusScrollTimerRef.current = null;
    }, 220);
  }, [animateScrollToBottom]);

  // Do not choose the initial scroll position until the entry catch-up has
  // completed. That lets us reliably distinguish missed messages from an empty
  // delta: jump to the oldest newly received message, otherwise to the chat end.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !msgs.data || refreshingOnEntry) return;

    const visible = visibleMessages.filter((message: any) => !message.deleted_at);
    const messageCountChanged = visible.length !== previousMessageCountRef.current;
    previousMessageCountRef.current = visible.length;
    const latestMessage = visible[visible.length - 1];

    if (!initialScrollDoneRef.current) {
      // Read persisted state synchronously as well, so a route reuse never
      // briefly jumps to the end before restoring the unread boundary.
      const separatorForEntry =
        activeNewMessagesSeparator ?? readNewMessagesSeparator(meId, conversationId);

      if (separatorForEntry) {
        if (!activeNewMessagesSeparator) setNewMessagesSeparator(separatorForEntry);
        const target = el.querySelector(
          `[data-msg-id="${separatorForEntry.firstMessageId}"]`,
        ) as HTMLElement | null;

        if (target) {
          initialScrollDoneRef.current = true;
          const containerRect = el.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const targetTop = el.scrollTop + targetRect.top - containerRect.top - 24;
          el.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
          return;
        }

        // The boundary can be older than the latest message page after a
        // refresh/cache reset. If it exists in memory but is outside the
        // rendered slice, reveal enough messages to render it before choosing
        // an entry position.
        const boundaryExistsInCache = (msgs.data ?? []).some(
          (message: any) => message.id === separatorForEntry.firstMessageId,
        );
        const boundaryIsVisible = allVisibleMessages.some(
          (message: any) => message.id === separatorForEntry.firstMessageId,
        );
        if (boundaryExistsInCache && !boundaryIsVisible) {
          // The stored boundary is no longer renderable (for example, it
          // expired or was deleted), so there is no valid message to anchor to.
          initialScrollDoneRef.current = true;
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          return;
        }
        if (boundaryIsVisible) {
          setVisibleMessageLimit((limit) => Math.max(limit, msgs.data?.length ?? limit));
          return;
        }

        // Never fall through to the chat end while a persisted new-message
        // boundary is still being resolved. Fetch that exact message, merge it
        // into the ordered cache, and let the next render scroll to it.
        if (entryBoundaryFetchRef.current !== separatorForEntry.firstMessageId) {
          entryBoundaryFetchRef.current = separatorForEntry.firstMessageId;
          void getMsg({ data: { messageId: separatorForEntry.firstMessageId } })
            .then((boundaryMessage: any) => {
              if (boundaryMessage) {
                queryClient.setQueryData<any[]>(["messages", conversationId], (current) =>
                  mergeMessages(current ?? [], [boundaryMessage]),
                );
                const currentCount =
                  queryClient.getQueryData<any[]>(["messages", conversationId])?.length ?? 0;
                setVisibleMessageLimit((limit) => Math.max(limit, currentCount));
              } else {
                // The boundary may have expired or been deleted. Only in that
                // case do we fall back to the end of the chat.
                initialScrollDoneRef.current = true;
                el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              }
            })
            .catch(() => {
              initialScrollDoneRef.current = true;
              el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            })
            .finally(() => {
              entryBoundaryFetchRef.current = null;
            });
        }
        return;
      }

      initialScrollDoneRef.current = true;
      // No new messages were found during catch-up: always land at the end,
      // even if some older messages still have stale unread receipts.
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = el;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 140;
    const shouldFollowNewMessage = messageCountChanged && (isNearBottom || latestMessage?.sender_id === meId);

    if ((isNearBottom || shouldFollowNewMessage) && !userScrolledUpRef.current) {
      requestAnimationFrame(() => animateScrollToBottom());
    }
  }, [activeNewMessagesSeparator?.firstMessageId, animateScrollToBottom, conversationId, getMsg, meId, queryClient, refreshingOnEntry, visibleMessages, msgs.data]);

  // If a separator is added or updated after the initial scroll, keep the oldest
  // missed message visible. During entry catch-up, wait so we don't jump to the
  // bottom before the server response tells us whether there are new messages.
  useLayoutEffect(() => {
    const firstMessageId = activeNewMessagesSeparator?.firstMessageId;
    if (refreshingOnEntry || !firstMessageId) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector(
      `[data-msg-id="${firstMessageId}"]`,
    ) as HTMLElement | null;
    if (target) {
      const containerRect = el.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTop = el.scrollTop + targetRect.top - containerRect.top - 24;
      el.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }, [activeNewMessagesSeparator?.firstMessageId, refreshingOnEntry, visibleMessages]);

  // Self-Destruct Messages: Client-side timer cleanup
  // Schedule removal for messages with expires_at (mirrored from delete_after).
  // The timer uses the persisted timestamp so it stays correct after refresh.
  // Before removing from cache, we verify with the server that the message
  // was actually deleted — this prevents stale timers from removing messages
  // that were saved after the timer was scheduled.
  useEffect(() => {
    if (!msgs.data || msgs.data.length === 0) return;

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const now = Date.now();

    for (const msg of msgs.data) {
      if (msg.deleted_at) continue;
      if (msg.is_saved) continue;
      if (!msg.expires_at) continue;

      const expiryTime = new Date(msg.expires_at).getTime();
      const delay = expiryTime - now;

      const fire = () => {
        void expireMsg({ data: { messageId: msg.id } })
          .then((res: any) => {
            if (res?.deleted) {
              queryClient.setQueryData(["messages", conversationId], (old: any) => {
                if (!Array.isArray(old)) return old;
                return old.filter((m: any) => m.id !== msg.id);
              });
            }
            // If not deleted (was saved or no longer expired), the realtime
            // UPDATE handler will have already updated is_saved/expires_at
            // in the cache, so the message stays visible correctly.
          })
          .catch(() => { });
        timers.delete(msg.id);
      };

      if (delay <= 0) {
        fire();
      } else {
        const timerId = setTimeout(fire, delay);
        timers.set(msg.id, timerId);
      }
    }

    return () => {
      for (const timerId of timers.values()) {
        clearTimeout(timerId);
      }
    };
  }, [msgs.data, conversationId, queryClient, expireMsg]);


  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = setTimeout(() => setHighlightedMessageId(null), 2200);
    return () => clearTimeout(timer);
  }, [highlightedMessageId]);

  useEffect(() => {
    if (!isInputFocused) return;
    if (typeof window === "undefined") return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    const onViewportResize = () => {
      if (!scrollingToEndOnFocusRef.current) return;
      animateScrollToBottom();
      if (viewportResizeTimerRef.current) {
        clearTimeout(viewportResizeTimerRef.current);
      }
      viewportResizeTimerRef.current = setTimeout(() => {
        scrollingToEndOnFocusRef.current = false;
        viewportResizeTimerRef.current = null;
      }, 240);
    };

    viewport.addEventListener("resize", onViewportResize);
    return () => {
      viewport.removeEventListener("resize", onViewportResize);
      if (viewportResizeTimerRef.current) {
        clearTimeout(viewportResizeTimerRef.current);
        viewportResizeTimerRef.current = null;
      }
      scrollingToEndOnFocusRef.current = false;
    };
  }, [isInputFocused, animateScrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !msgs.data) return;

    const handleScroll = () => {
      if (scrollUpdateFrameRef.current !== null) return;

      scrollUpdateFrameRef.current = requestAnimationFrame(() => {
        scrollUpdateFrameRef.current = null;

        const { scrollTop, scrollHeight, clientHeight } = el;
        const threshold = isMobile ? 50 : 120;
        const distFromBottom = scrollHeight - scrollTop - clientHeight;
        const isAtBottom = distFromBottom < threshold;

        setShowJumpToLatestButton((current) => {
          const next = !isAtBottom;
          return current === next ? current : next;
        });
        isNearBottomRef.current = isAtBottom;

        // Reaching the end of the conversation completes the unread-message
        // boundary, even if some messages were skipped during a fast scroll.
        if (isAtBottom) {
          setNewMessagesSeparator((current) =>
            current?.conversationId === conversationId ? null : current,
          );
        }

        // Detect intentional upward scroll
        if (scrollTop < lastScrollTopRef.current && !isAnimatingScrollRef.current) {
          userScrolledUpRef.current = true;
        } else if (isAtBottom) {
          userScrolledUpRef.current = false;
        }
        lastScrollTopRef.current = scrollTop;

        const unreadBelow = isAtBottom ? 0 : unreadMessageCount;
        setUnreadBelowScroll((current) => current === unreadBelow ? current : unreadBelow);

        if (scrollIdleTimeoutRef.current) clearTimeout(scrollIdleTimeoutRef.current);
        scrollIdleTimeoutRef.current = setTimeout(() => {
          scrollIdleTimeoutRef.current = null;
          if (isChatActuallyViewed()) void markSeenNow();
        }, 100);
      });
    };

    const handleUserScrollInterruption = () => {
      if (isAnimatingScrollRef.current) {
        cancelScrollAnimation();
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("wheel", handleUserScrollInterruption, { passive: true });
    el.addEventListener("touchstart", handleUserScrollInterruption, { passive: true });
    el.addEventListener("pointerdown", handleUserScrollInterruption);

    handleScroll();

    return () => {
      if (scrollUpdateFrameRef.current !== null) {
        cancelAnimationFrame(scrollUpdateFrameRef.current);
        scrollUpdateFrameRef.current = null;
      }
      if (scrollIdleTimeoutRef.current) {
        clearTimeout(scrollIdleTimeoutRef.current);
        scrollIdleTimeoutRef.current = null;
      }
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", handleUserScrollInterruption);
      el.removeEventListener("touchstart", handleUserScrollInterruption);
      el.removeEventListener("pointerdown", handleUserScrollInterruption);
    };
  }, [cancelScrollAnimation, isChatActuallyViewed, markSeenNow, unreadMessageCount, isMobile, msgs.data]);

  useEffect(() => {
    return () => {
      if (focusScrollTimerRef.current) {
        clearTimeout(focusScrollTimerRef.current);
        focusScrollTimerRef.current = null;
      }
      if (viewportResizeTimerRef.current) {
        clearTimeout(viewportResizeTimerRef.current);
        viewportResizeTimerRef.current = null;
      }
      cancelScrollAnimation();
    };
  }, [cancelScrollAnimation]);

  const jumpToMessage = useCallback(
    async (targetId: string) => {
      if (!scrollRef.current) return;
      const el = scrollRef.current;
      let msgEl = el.querySelector(`[data-msg-id="${targetId}"]`) as HTMLElement | null;

      if (!msgEl) {
        try {
          const remoteMessage = await getMsg({ data: { messageId: targetId } });
          if (remoteMessage) {
            queryClient.setQueryData(["messages", conversationId], (old: any) => {
              return mergeMessages(old ?? [], [remoteMessage]);
            });
            await waitForRender();
            await new Promise((resolve) => setTimeout(resolve, 80));
            msgEl = el.querySelector(`[data-msg-id="${targetId}"]`) as HTMLElement | null;
          }
        } catch (err) {
          // ignore fetch failure and fall through to native logic
        }
      }

      if (msgEl) {
        msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightedMessageId(targetId);
      } else {
        toast.error("Referenced message unavailable or deleted.");
      }
    },
    [conversationId, getMsg, queryClient, waitForRender],
  );


  // Typing state is event-driven via the draft channel and expires locally.
  // Do not poll typing_status: the broadcast stream is the live source of truth.
  const onEdited = useCallback(() => { }, []);
  const handleReply = useCallback((message: any) => {
    setReplyTarget(message);
  }, []);

  function handleSettingsChange(partial: any) {
    queryClient.setQueryData(["conv-settings", conversationId], (old: any) => ({ ...old, ...partial }));
  }

  async function handlePinVerify(pin: string): Promise<boolean | void> {
    const cachedHash = settings?.pin_hash;
    let valid: boolean;

    if (cachedHash && cachedHash !== "device-locked") {
      const bcrypt = await import("bcryptjs");
      valid = await bcrypt.compare(pin, cachedHash);
    } else {
      ({ valid } = await verifyPin({ data: { conversationId, pin } }));
    }

    if (!valid) return false;
    if (protectedMessagesPrefetchRef.current) {
      queryClient.setQueryData(["messages", conversationId], protectedMessagesPrefetchRef.current);
    }
    setIsUnlocked(true);
    setShowPinPrompt(false);
    void queryClient.invalidateQueries({ queryKey: ["messages", conversationId], exact: true });
  }

  async function handleSecretVerify(code: string): Promise<boolean | void> {
    const { valid } = await verifySecret({ data: { conversationId, code } });
    if (!valid) return false;
    if (protectedMessagesPrefetchRef.current) {
      queryClient.setQueryData(["messages", conversationId], protectedMessagesPrefetchRef.current);
    }
    unlockGlobally(conversationId);
    setIsSecretUnlocked(true);
    setShowSecretPrompt(false);
    void queryClient.invalidateQueries({ queryKey: ["messages", conversationId], exact: true });
  }


  // Only show the weak-connection message if the initial loading spinner lasts
  // longer than four seconds. Fast loads keep the UI clean and quiet.
  useEffect(() => {
    const isWaitingForInitialMessages =
      !settingsQuery?.isError &&
      settingsQuery?.isSuccess &&
      !isLocked &&
      !isHiddenLocked &&
      (msgs.isLoading || refreshingOnEntry);

    if (!isWaitingForInitialMessages) {
      setShowWeakConnection(false);
      return;
    }

    const timer = window.setTimeout(() => setShowWeakConnection(true), 4000);
    return () => window.clearTimeout(timer);
  }, [
    settingsQuery?.isError,
    settingsQuery?.isSuccess,
    isLocked,
    isHiddenLocked,
    msgs.data?.length,
    msgs.isLoading,
    refreshingOnEntry,
  ]);

  const theme = settings?.theme ?? "obsidian";
  const wallpaper = settings?.wallpaper_url ?? "none";
  const wallpaperClass = WALLPAPER_STYLE[wallpaper] ?? "";
  const themeBg = THEME_BG[theme] ?? "";

  const hasSavedByMe = (msgs.data ?? []).some((m: any) => m.saved_by_me);

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", themeBg)}>
      <ChatHeader
        conversationId={conversationId}
        other={conv.data?.other ?? null}
        onLeft={() => queryClient.invalidateQueries({ queryKey: ["conversations"] })}
        settings={settings}
        onSettingsChange={handleSettingsChange}
        onUnlocked={() => setIsUnlocked(true)}
        isUnlocked={isUnlocked}
        isHiddenLocked={isHiddenLocked}
        loading={conv.isLoading && !conv.data}
        hasSavedByMe={hasSavedByMe}
        otherIsViewing={otherIsViewing}
      />

      {!settingsQuery.isSuccess ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          {settingsQuery.isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <AlertCircle className="size-5" />
          )}
          <p>
            {settingsQuery.isLoading
              ? "Checking chat privacy settings"
              : "Could not verify this chat's privacy settings"}
          </p>
          {settingsQuery.isError && (
            <button
              onClick={() => void settingsQuery.refetch()}
              className="rounded-lg border px-3 py-1.5 text-xs text-foreground"
            >
              Retry
            </button>
          )}
        </div>
      ) : isLocked || isHiddenLocked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="rounded-full bg-slate-400/10 p-4">
            {isHiddenLocked ? <KeyRound className="size-10 text-slate-400" /> : <Lock className="size-10 text-amber-400" />}
          </div>
          <div>
            <h3 className="font-display text-xl text-foreground">
              {isHiddenLocked ? "Hidden Chat" : "This chat is locked"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {isHiddenLocked ? "Enter secret code to reveal conversation" : "Enter your PIN to view messages"}
            </p>
          </div>
          <button
            onClick={() => (isHiddenLocked ? setShowSecretPrompt(true) : setShowPinPrompt(true))}
            className="rounded-xl bg-foreground px-6 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            {isHiddenLocked ? "Unlock with Code" : "Enter PIN"}
          </button>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            data-wallpaper={wallpaper}
            className={cn("message-stream chat-wallpaper min-h-0 flex-1 overflow-y-auto scroll-pb-32 px-4 py-6 pb-32 space-y-5 sm:px-8 sm:pb-28 no-scrollbar relative", wallpaperClass)}
          >
            {refreshingOnEntry && !!msgs.data?.length && (
              <div
                className="flex justify-start py-1"
                role="status"
                aria-live="polite"
                aria-label="Checking for new messages"
              >
                <div className="max-w-[78%] min-w-36 rounded-2xl rounded-bl-md border border-border/50 bg-muted/55 px-4 py-3 shadow-sm">
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    <span>Checking for new messages</span>
                  </div>
                  <div className="space-y-2" aria-hidden="true">
                    <div className="h-2 w-44 max-w-full animate-pulse rounded-full bg-foreground/10" />
                    <div className="h-2 w-28 max-w-[75%] animate-pulse rounded-full bg-foreground/10" />
                  </div>
                  {showWeakConnection && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Slow connection — still checking…
                    </p>
                  )}
                </div>
              </div>
            )}
            {(visibleMessageLimit < allVisibleMessages.length || pagination.data?.hasMoreOlder) && (
              <button
                type="button"
                onClick={() => void loadEarlierMessages()}
                disabled={loadingOlder}
                className="mx-auto block rounded-full border border-border bg-background/80 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                {loadingOlder ? "Loading earlier messages..." : "Load earlier messages"}
              </button>
            )}
            {(msgs.isLoading || (refreshingOnEntry && !msgs.data?.length)) && !msgs.data?.length && (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 px-6 text-center" role="status" aria-live="polite">
                <div className="grid size-12 place-items-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                  <Loader2 className="size-5 animate-spin" />
                </div>
                {showWeakConnection && (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium text-foreground">Oops, you have a weak connection</p>
                    <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">We’re still loading your conversation. Keep this screen open; your messages will appear as soon as they’re ready.</p>
                  </div>
                )}
              </div>
            )}
            {msgs.isError && (
              <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-sm text-red-400">
                <AlertCircle className="size-5" />
                <p className="font-medium text-foreground">Oops, you have a weak connection</p>
                <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">We couldn’t finish loading this conversation yet.</p>
                <button
                  onClick={() => void msgs.refetch()}
                  className="mt-1 rounded-full border border-border px-4 py-2 text-xs text-foreground transition-colors hover:bg-muted"
                >
                  Retry loading
                </button>
              </div>
            )}
            {(() => {
              const filtered = visibleMessages;
              const separatorIndex = activeNewMessagesSeparator
                ? filtered.findIndex((message: any) => message.id === activeNewMessagesSeparator.firstMessageId)
                : -1;

              let prevDate: Date | null = null;
              return filtered.map((m: any, idx: number) => {
                const currentDate = new Date(m.created_at);
                const showDateSeparator = shouldShowSeparator(prevDate, currentDate);
                prevDate = currentDate;

                if (m.message_type === "system") {
                  return (
                    <div key={m.id} className="flex justify-center my-6">
                      <span className="px-4 py-1.5 bg-neutral-800/40 backdrop-blur-sm border border-white/5 text-black dark:text-white text-[10px] rounded-full uppercase tracking-widest font-semibold shadow-xl">
                        {m.content}
                      </span>
                    </div>
                  );
                }

                return (
                  <div key={m.id} data-msg-id={m.id}>
                    {showDateSeparator && <DateSeparator date={currentDate} />}
                    {idx === separatorIndex && activeNewMessagesSeparator && (
                      <div className="my-4 flex items-center gap-3" role="status" aria-label={`${activeNewMessagesSeparator.count} new messages`}>
                        <span className="h-px flex-1 bg-red-500" />
                        <span className="shrink-0 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white shadow-sm">
                          {activeNewMessagesSeparator.count} new messages
                        </span>
                        <span className="h-px flex-1 bg-red-500" />
                      </div>
                    )}
                    <div
                      className={cn(
                        "[content-visibility:auto] [contain-intrinsic-size:0_88px]",
                        idx === visibleMessages.length - 1 && "animate-message-entry",
                      )}
                      style={{
                        contain: "layout paint style",
                        animationDelay: `${Math.min(idx, 9) * 18}ms`,
                      }}
                    >
                      <MessageBubble
                        m={m as any}
                        mine={m.sender_id === meId}
                        onEdited={onEdited}
                        onReply={handleReply}
                        onJumpToReply={jumpToMessage}
                        highlighted={highlightedMessageId === m.id}
                        meId={meId}
                        theme={theme}
                      />
                    </div>
                  </div>
                );
              });
            })()}
            {otherUserDraft && draftPreviewEnabled && (
              <div className="relative z-10">
                <DraftBubble text={otherUserDraft} />
              </div>
            )}
            {msgs.data && msgs.data.length === 0 && !msgs.isLoading && (
              <div className="flex h-full min-h-[200px] items-center justify-center text-center text-sm text-muted-foreground">
                <div>
                  <p>This is a fresh, private conversation.</p>
                  <p className="mt-1 text-xs">Say hello — messages disappear when you both leave.</p>
                </div>
              </div>
            )}

          </div>

          <ActivityIndicator
            active={otherIsViewing}
            name={conv.data?.other?.display_name ?? conv.data?.other?.username}
            className="pointer-events-none absolute bottom-[5.75rem] right-4 z-20 sm:right-8"
          />

          {/* Floating one-click navigation to the latest message */}
          <div
            className={cn(
              "absolute bottom-24 right-4 z-30 transition-[opacity,transform] duration-300 ease-out",
              showJumpToLatestButton
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-3 scale-95 opacity-0",
            )}
          >
            <button
              type="button"
              onClick={animateScrollToBottom}
              className={cn(
                "group relative inline-flex h-11 items-center gap-2 rounded-full border border-white/20",
                "bg-gradient-to-r from-primary to-primary/90 px-4 text-sm font-semibold text-primary-foreground",
                "shadow-[0_8px_28px_rgba(0,0,0,0.22)] backdrop-blur-xl",
                "transition-[transform,box-shadow,filter] duration-200 ease-out",
                "hover:-translate-y-0.5 hover:shadow-[0_12px_32px_rgba(0,0,0,0.28)]",
                "active:translate-y-0 active:scale-[0.97]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              )}
              aria-label={`Go to end${unreadBelowScroll > 0 ? `, ${unreadBelowScroll} unread messages` : ""}`}
            >
              <span>Go to end</span>
              <ArrowDown className="size-4 transition-transform duration-200 group-hover:translate-y-0.5" />

              {unreadBelowScroll > 0 && (
                <span
                  className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-background/20 px-1 text-[10px] font-bold text-primary-foreground"
                >
                  {unreadBelowScroll > 99 ? "99+" : unreadBelowScroll}
                </span>
              )}
            </button>
          </div>

          <Composer
            conversationId={conversationId}
            replyTo={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            onFocus={() => {
              setIsInputFocused(true);
              scrollToBottomOnFocus();
            }}
            onBlur={() => setIsInputFocused(false)}
            isTyping={isTyping}
            other={conv.data?.other ?? null}
            meId={meId}
            draftPreviewEnabled={draftPreviewEnabled}
            onTypingChange={(typing) => {
              setIsTyping(typing);
              if (typing) {
                if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                typingTimerRef.current = setTimeout(() => setIsTyping(false), 4000);
              } else {
                if (typingTimerRef.current) {
                  clearTimeout(typingTimerRef.current);
                  typingTimerRef.current = null;
                }
              }
            }}
            onDraftChange={(text) => setOtherUserDraft(text)}
          />
        </>
      )}

      {showPinPrompt && (
        <PinDialog
          open
          title="Chat is Locked"
          description="Enter your 6-digit PIN to unlock"
          onSubmit={handlePinVerify}
          onCancel={() => setShowPinPrompt(false)}
          errorMessage="Incorrect PIN"
        />
      )}

      {showSecretPrompt && (
        <SecretCodeDialog
          open
          title="Hidden Conversation"
          description="Enter your secret code to reveal this chat"
          onSubmit={handleSecretVerify}
          onCancel={() => setShowSecretPrompt(false)}
          errorMessage="Incorrect Secret Code"
        />
      )}
    </div>
  );
}
