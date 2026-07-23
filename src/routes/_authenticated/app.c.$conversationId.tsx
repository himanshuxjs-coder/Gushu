import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
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
import { verifyConversationPin } from "@/lib/conversation-settings.functions";
import { toast } from "sonner";

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
  grid: "bg-[radial-gradient(circle,_rgba(255,255,255,0.05)_1px,_transparent_1px)] bg-[size:20px_20px]",
  dots: "bg-[radial-gradient(rgba(255,255,255,0.1)_1px,_transparent_1px)] bg-[size:16px_16px]",
  waves: "bg-gradient-to-br from-blue-950/20 via-blue-900/20 to-blue-950/20",
  aurora: "bg-gradient-to-br from-emerald-950/20 via-teal-900/20 to-emerald-950/20",
};

function ChatPage() {
  const { conversationId } = Route.useParams();
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
  const isUnlockedGlobally = useHiddenStore((s: any) => s.isUnlocked(conversationId));
  const unlockGlobally = useHiddenStore((s: any) => s.unlock);
  const realtimeRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const markReadRef = useRef(false);
  const markReadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markReadCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialMessagesLoadedRef = useRef(false);
  const previousMessageCountRef = useRef(0);

  const conv = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConv({ data: { id: conversationId } }),
    staleTime: 30000,
  });

  const settingsQuery = useQuery({
    queryKey: ["conv-settings", conversationId],
    queryFn: () => getSettings({ data: { conversationId } }),
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const settings = settingsQuery.data ?? null;
  const isVerified = currentUserVerified.data?.verified ?? false;

  const isLocked = !!settings?.is_locked && !!settings?.pin_hash && !isUnlocked;
  const isHiddenLocked =
    !!settings?.is_hidden && !!settings?.secret_code_hash && !isSecretUnlocked && !isUnlockedGlobally;

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
      const serverMessages = await listMsgs({ data: { conversationId } });
      const previous = queryClient.getQueryData<any>(["messages", conversationId]) ?? [];
      return mergeMessages(previous, serverMessages);
    },
    enabled: !isLocked && !isHiddenLocked,
    staleTime: 3000,
    refetchOnWindowFocus: true,
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!conversationId) return;

    const markActive = async () => {
      await supabase.rpc("mark_conversation_active", {
        p_conversation_id: conversationId,
      });
    };

    // Immediately mark active
    markActive();

    // Keep presence alive every 20 seconds
    presenceTimerRef.current = setInterval(markActive, 20000);

    return async () => {
      if (presenceTimerRef.current) {
        clearInterval(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }

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
                    unread: msg.sender_id === meId ? c.unread : (c.unread ?? 0) + 1,
                  }
                : c,
            );
          });

          if (msg.sender_id === meId || isNearBottomRef.current || !userScrolledUpRef.current) {
            requestAnimationFrame(() => animateScrollToBottom());
            window.setTimeout(() => animateScrollToBottom(), 120);
          }
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

    subscribeWithReconnect(ch);
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

  // Mark messages as seen only when the active chat is actually visible and focused.
  // This prevents false read receipts from background tabs, hidden pages, or route switches.
  // Messages are marked as seen immediately when the chat loads or when new unread messages arrive.
  useEffect(() => {
    if (!conversationId || !msgs.data?.length || isLocked || isHiddenLocked) {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
        markReadTimeoutRef.current = null;
      }
      return;
    }

    const hasUnread = msgs.data.some((msg: any) => msg.sender_id !== meId && !msg.read_at);
    if (!hasUnread) {
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

      void markConversationSeenIfVisible({
        conversationId,
        messages: msgs.data ?? [],
        meId,
        queryClient,
        markRead: mark,
        isConversationActive: true,
      }).catch(() => {});

      if (markReadCooldownRef.current) {
        clearTimeout(markReadCooldownRef.current);
      }
      markReadCooldownRef.current = setTimeout(() => {
        markReadRef.current = false;
      }, 800);
    }, 0);

    return () => {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
        markReadTimeoutRef.current = null;
      }
    };
  }, [conversationId, msgs.data, isLocked, isHiddenLocked, mark, meId, queryClient]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        if (markReadTimeoutRef.current) {
          clearTimeout(markReadTimeoutRef.current);
          markReadTimeoutRef.current = null;
        }
        initialMessagesLoadedRef.current = true;
      }
    };

    const handleWindowFocus = () => {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
        markReadTimeoutRef.current = null;
      }
      initialMessagesLoadedRef.current = true;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, []);

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

    const duration = Math.min(520, Math.max(260, Math.abs(distance) * 0.4));
    const startTime = performance.now();
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

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

  // Smart auto-scroll: on first load jump to first unread, afterwards only
  // auto-scroll if user is already near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !msgs.data) return;

    // Build visible, non-expired list
    const now = Date.now();
    const visible = (msgs.data ?? []).filter((m: any) => {
      if (m.deleted_at) return false;
      if (m.is_saved) return true;
      if (!m.expires_at) return true;
      return new Date(m.expires_at).getTime() > now;
    });

    const messageCountChanged = visible.length !== previousMessageCountRef.current;
    previousMessageCountRef.current = visible.length;
    const latestMessage = visible[visible.length - 1];
    const firstUnreadIndex = visible.findIndex((m: any) => m.sender_id !== meId && !m.seen_at);

    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      if (firstUnreadIndex !== -1) {
        const targetId = visible[firstUnreadIndex].id;
        const msgEl = el.querySelector(`[data-msg-id="${targetId}"]`) as HTMLElement | null;
        if (msgEl) {
          el.scrollTo({ top: msgEl.offsetTop - 20, behavior: "auto" });
          return;
        }
      }
      // Fallback: scroll to bottom
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      return;
    }

    // After initial load, follow the latest message when the user is near the bottom
    // or when a new message is sent/received and the conversation is already following the feed.
    const { scrollTop, scrollHeight, clientHeight } = el;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 140;
    const shouldFollowNewMessage = messageCountChanged && (isNearBottom || latestMessage?.sender_id === meId);

    if ((isNearBottom || shouldFollowNewMessage) && !userScrolledUpRef.current) {
      requestAnimationFrame(() => animateScrollToBottom());
      window.setTimeout(() => animateScrollToBottom(), 120);
    }
  }, [animateScrollToBottom, msgs.data, meId]);

  // Self-Destruct Messages: Client-side timer cleanup
  // Schedule removal for messages with expires_at
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

      if (delay <= 0) {
        void expireMsg({ data: { messageId: msg.id } }).catch(() => {});
        queryClient.setQueryData(["messages", conversationId], (old: any) => {
          if (!Array.isArray(old)) return old;
          return old.filter((m: any) => m.id !== msg.id);
        });
      } else {
        const timerId = setTimeout(() => {
          void expireMsg({ data: { messageId: msg.id } }).catch(() => {});
          queryClient.setQueryData(["messages", conversationId], (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.filter((m: any) => m.id !== msg.id);
          });
          timers.delete(msg.id);
        }, delay);
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

  const isMobile = useIsMobile();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !msgs.data) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const threshold = isMobile ? 50 : 120;
      const distFromBottom = scrollHeight - scrollTop - clientHeight;
      const isAtBottom = distFromBottom < threshold;

      setShowJumpToLatestButton(!isAtBottom);
      isNearBottomRef.current = isAtBottom;

      // Detect intentional upward scroll
      if (scrollTop < lastScrollTopRef.current && !isAnimatingScrollRef.current) {
        userScrolledUpRef.current = true;
      } else if (isAtBottom) {
        userScrolledUpRef.current = false;
      }
      lastScrollTopRef.current = scrollTop;

      if (!isAtBottom && msgs.data) {
        const bottomMessages = msgs.data.filter((m: any) => m.sender_id !== meId && !m.read_at);
        setUnreadBelowScroll(Math.max(0, bottomMessages.length));
      } else {
        setUnreadBelowScroll(0);
      }
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
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", handleUserScrollInterruption);
      el.removeEventListener("touchstart", handleUserScrollInterruption);
      el.removeEventListener("pointerdown", handleUserScrollInterruption);
    };
  }, [cancelScrollAnimation, msgs.data, meId, isMobile]);

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


  // Typing indicator is now handled via realtime broadcast events on the draft channel.
  // Fallback: poll every 5s in case realtime events are missed.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const { supabase: sb } = await import("@/integrations/supabase/client");
        const { data } = await sb
          .from("typing_status")
          .select("user_id, typing_at")
          .eq("conversation_id", conversationId)
          .neq("user_id", meId);
        const now = Date.now();
        const active = (data ?? []).filter((r) => now - new Date(r.typing_at).getTime() < 4000);
        // Only update if no recent realtime event (debounce to avoid flickering)
        if (active.length === 0) {
          setIsTyping(false);
        }
      } catch {}
    };
    // Poll less frequently (5s) as realtime events are primary
    intervalId = setInterval(poll, 5000);
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [conversationId, meId]);

  const onEdited = useCallback(() => {}, []);

  function handleSettingsChange(partial: any) {
    queryClient.setQueryData(["conv-settings", conversationId], (old: any) => ({ ...old, ...partial }));
  }

  async function handlePinVerify(pin: string): Promise<boolean | void> {
    const { valid } = await verifyPin({ data: { conversationId, pin } });
    if (!valid) return false;
    setIsUnlocked(true);
    setShowPinPrompt(false);
  }

  async function handleSecretVerify(code: string): Promise<boolean | void> {
    const { valid } = await verifySecret({ data: { conversationId, code } });
    if (!valid) return false;
    unlockGlobally(conversationId);
    setIsSecretUnlocked(true);
    setShowSecretPrompt(false);
  }

  const theme = settings?.theme ?? "obsidian";
  const wallpaper = settings?.wallpaper_url ?? "none";
  const wallpaperClass = WALLPAPER_STYLE[wallpaper] ?? "";
  const themeBg = THEME_BG[theme] ?? "";

  const hasSavedByMe = (msgs.data ?? []).some((m: any) => m.saved_by_me);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", themeBg)}>
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
        isCollapsed={isInputFocused}
        hasSavedByMe={hasSavedByMe}
      />

      {isLocked || isHiddenLocked ? (
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
            className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-6 space-y-5 sm:px-8 no-scrollbar relative", wallpaperClass)}
          >
            {msgs.isLoading && (
              <div className="grid h-full place-items-center text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            )}
            {msgs.isError && (
              <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-sm text-red-400">
                <AlertCircle className="size-5" />
                <p>Failed to load messages</p>
                <button
                  onClick={() => msgs.refetch()}
                  className="text-xs underline underline-offset-2 hover:no-underline"
                >
                  Try again
                </button>
              </div>
            )}
            {(() => {
              const now = Date.now();
              const filtered = (msgs.data ?? []).filter((m: any) => {
                if (m.is_saved) return true;
                if (!m.expires_at) return true;
                return new Date(m.expires_at).getTime() > now;
              });

              const firstUnreadIndex = filtered.findIndex((m: any) => m.sender_id !== meId && !m.read_at);

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
                    {/* Insert a WhatsApp-style "New messages" divider before the first unread message */}
                    {idx === firstUnreadIndex && (
                      <div className="flex justify-center my-3">
                        <span className="px-4 py-1.5 bg-emerald-600 text-white text-[12px] rounded-full font-semibold shadow-sm">New messages</span>
                      </div>
                    )}
                    <div className={cn("animate-in-fade", idx < 8 && `stagger-${Math.min(idx + 1, 5)}`)}>
                      <MessageBubble
                        m={m as any}
                        mine={m.sender_id === meId}
                        onEdited={onEdited}
                        onReply={(mm) => setReplyTarget(mm)}
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
            {otherUserDraft && draftPreviewEnabled && <DraftBubble text={otherUserDraft} />}
            {msgs.data && msgs.data.length === 0 && !msgs.isLoading && (
              <div className="flex h-full min-h-[200px] items-center justify-center text-center text-sm text-muted-foreground">
                <div>
                  <p>This is a fresh, private conversation.</p>
                  <p className="mt-1 text-xs">Say hello — messages disappear when you both leave.</p>
                </div>
              </div>
            )}

          </div>

          {/* Modern floating "Go to Latest" button */}
          <div
            className={cn(
              "absolute bottom-24 right-4 z-30 transition-all duration-300 ease-out",
              showJumpToLatestButton
                ? "opacity-100 scale-100 translate-y-0"
                : "opacity-0 scale-75 translate-y-4 pointer-events-none",
            )}
          >
            <button
              type="button"
              onClick={animateScrollToBottom}
              className={cn(
                "relative flex items-center justify-center",
                "size-12 rounded-full",
                // Modern glassmorphism
                "bg-gradient-to-br from-primary/90 via-primary to-primary/90",
                "backdrop-blur-xl",
                // Border and shadow
                "border-2 border-white/20",
                "shadow-[0_8px_32px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.1)_inset]",
                // Hover effects
                "hover:scale-110 hover:shadow-[0_12px_40px_rgba(139,92,246,0.4)]",
                // Active
                "active:scale-95",
                // Transition
                "transition-all duration-200 ease-out",
              )}
              aria-label={`Jump to latest${unreadBelowScroll > 0 ? ` (${unreadBelowScroll} unread)` : ""}`}
            >
              <ArrowDown className="size-5 text-white" />

              {/* Unread badge */}
              {unreadBelowScroll > 0 && (
                <span
                  className={cn(
                    "absolute -top-1 -right-1 flex items-center justify-center",
                    "min-w-5 h-5 px-1",
                    "bg-gradient-to-br from-red-500 to-red-600",
                    "text-white text-[10px] font-bold rounded-full",
                    "shadow-[0_2px_8px_rgba(239,68,68,0.5)]",
                    "animate-pulse",
                  )}
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
