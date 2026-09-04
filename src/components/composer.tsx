import { useRef, useState, useEffect, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Paperclip, Send, Smile, Loader as Loader2, X, Mic, Camera, CalendarClock, ChevronUp, Pencil, Trash2 } from "lucide-react";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Drawer, DrawerContent, DrawerTrigger, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { VoiceRecorder } from "./voice-recorder";
import { CameraCapture } from "./camera-capture";
import { createMediaUpload, sendMessage } from "@/lib/messages.functions";
import { setTyping, clearTyping } from "@/lib/presence.functions";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDraft } from "@/hooks/use-draft";
import { subscribeWithReconnect } from "@/lib/realtime-utils";
import { cancelScheduledMessage, createScheduledMessage, listScheduledMessages, updateScheduledMessage } from "@/lib/scheduling.functions";

const MAX_MESSAGE_LENGTH = 4000;

type ScheduledMessage = {
  id: string;
  content: string;
  scheduled_for: string;
  status: "pending" | "sent" | "cancelled";
};

function kindForMime(mime: string): "image" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function Composer({
  conversationId,
  replyTo,
  onCancelReply,
  onFocus,
  onBlur,
  isTyping,
  other,
  meId,
  draftPreviewEnabled,
  onTypingChange,
  onDraftChange,
}: {
  conversationId: string;
  replyTo?: any | null;
  onCancelReply?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  isTyping?: boolean;
  other?: any | null;
  meId: string;
  draftPreviewEnabled?: boolean;
  onTypingChange?: (isTyping: boolean) => void;
  onDraftChange?: (text: string | null) => void;
}) {
  const { text, setText, clear: clearDraft, loaded: draftLoaded } = useDraft(conversationId);
  const [busy, setBusy] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [drag, setDrag] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleListOpen, setScheduleListOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledMessage | null>(null);
  const [scheduleContent, setScheduleContent] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const sendHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTypingSentRef = useRef<number>(0);
  const draftChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const draftDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const lastDraftTextRef = useRef<string>("");
  const onTypingChangeRef = useRef(onTypingChange);
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onTypingChangeRef.current = onTypingChange;
    onDraftChangeRef.current = onDraftChange;
  });
  const send = useServerFn(sendMessage);
  const createUpload = useServerFn(createMediaUpload);
  const setTypingStatus = useServerFn(setTyping);
  const clearTypingStatus = useServerFn(clearTyping);
  const listScheduled = useServerFn(listScheduledMessages);
  const createScheduled = useServerFn(createScheduledMessage);
  const updateScheduled = useServerFn(updateScheduledMessage);
  const cancelScheduled = useServerFn(cancelScheduledMessage);
  const queryClient = useQueryClient();

  const refreshScheduledMessages = useCallback(async () => {
    try {
      const rows = await listScheduled({ data: { conversationId } });
      setScheduledMessages(rows as ScheduledMessage[]);
    } catch {
      setScheduledMessages([]);
    }
  }, [conversationId, listScheduled]);

  const defaultScheduleTime = useCallback(() => {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    date.setSeconds(0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, []);

  const formatScheduleTimeForInput = useCallback((scheduledFor: string) => {
    const date = new Date(scheduledFor);
    if (Number.isNaN(date.getTime())) return defaultScheduleTime();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, [defaultScheduleTime]);

  const openSchedule = useCallback((message = text, item: ScheduledMessage | null = null) => {
    setEditingSchedule(item);
    setScheduleContent(item?.content ?? message);
    setScheduleTime(item ? formatScheduleTimeForInput(item.scheduled_for) : defaultScheduleTime());
    setScheduleOpen(true);
    setScheduleListOpen(true);
  }, [defaultScheduleTime, formatScheduleTimeForInput, text]);

  const closeSchedule = useCallback(() => {
    setScheduleOpen(false);
    setEditingSchedule(null);
  }, []);

  const submitSchedule = async () => {
    if (!scheduleContent.trim() || !scheduleTime || scheduleBusy) return;
    setScheduleBusy(true);
    try {
      const scheduledFor = new Date(scheduleTime).toISOString();
      if (editingSchedule) {
        await updateScheduled({ data: { id: editingSchedule.id, content: scheduleContent, scheduledFor } });
        toast.success("Scheduled message updated");
      } else {
        await createScheduled({ data: { conversationId, content: scheduleContent, scheduledFor } });
        setText("");
        clearDraftBroadcast();
        toast.success("Message scheduled");
      }
      await refreshScheduledMessages();
      closeSchedule();
    } catch (error: any) {
      toast.error(error?.message ?? "Could not schedule message");
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleCancelScheduled = async (id: string) => {
    try {
      await cancelScheduled({ data: { id } });
      setScheduledMessages((current) => current.filter((item) => item.id !== id));
      toast.success("Scheduled message cancelled");
    } catch (error: any) {
      toast.error(error?.message ?? "Could not cancel scheduled message");
    }
  };

  const clearSendHold = () => {
    if (sendHoldTimerRef.current) {
      clearTimeout(sendHoldTimerRef.current);
      sendHoldTimerRef.current = null;
    }
  };

  const handleSendPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    longPressTriggeredRef.current = false;
    clearSendHold();
    sendHoldTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      openSchedule();
    }, 550);
    refocusInput();
  };

  useEffect(() => {
    void refreshScheduledMessages();
    const scheduleChannel = supabase
      .channel(`scheduled:${conversationId}:${meId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_messages", filter: `sender_id=eq.${meId}` }, () => {
        void refreshScheduledMessages();
      });
    subscribeWithReconnect(scheduleChannel);
    return () => {
      void supabase.removeChannel(scheduleChannel);
    };
  }, [conversationId, meId, refreshScheduledMessages]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      clearTypingStatus({ data: { conversationId } }).catch(() => {});
    };
  }, [conversationId, clearTypingStatus]);

  // Set up draft broadcast channel when draft preview is enabled
  useEffect(() => {
    if (!draftPreviewEnabled) {
      if (draftChannelRef.current) {
        supabase.removeChannel(draftChannelRef.current);
        draftChannelRef.current = null;
      }
      return;
    }

    // Clean up any existing channel
    if (draftChannelRef.current) {
      supabase.removeChannel(draftChannelRef.current);
    }

    const draftChannel = supabase.channel(`draft:${conversationId}`, {
      config: { broadcast: { self: false } },
    });
    draftChannel
      .on("broadcast", { event: "draft" }, (payload) => {
        const data = payload.payload as { userId: string; text: string } | null;
        if (!data || data.userId === meId) return;
        onDraftChangeRef.current?.(data.text || null);
      })
      .on("broadcast", { event: "draft-clear" }, (payload) => {
        const data = payload.payload as { userId: string } | null;
        if (!data || data.userId === meId) return;
        onDraftChangeRef.current?.(null);
      })
      .on("broadcast", { event: "typing" }, (payload) => {
        const data = payload.payload as { userId: string } | null;
        if (!data || data.userId === meId) return;
        onTypingChangeRef.current?.(true);
      })
      .on("broadcast", { event: "typing-clear" }, (payload) => {
        const data = payload.payload as { userId: string } | null;
        if (!data || data.userId === meId) return;
        onTypingChangeRef.current?.(false);
      });

    subscribeWithReconnect(draftChannel);
    draftChannelRef.current = draftChannel;

    return () => {
      if (draftChannelRef.current) {
        // Broadcast final clear when unmounting
        draftChannelRef.current.send({
          type: "broadcast",
          event: "draft-clear",
          payload: { userId: meId },
        }).catch(() => {});
        supabase.removeChannel(draftChannelRef.current);
        draftChannelRef.current = null;
      }
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }
    };
  }, [conversationId, draftPreviewEnabled, meId]);

  const handleTyping = useCallback(
    (currentText: string) => {
      if (!currentText.trim()) {
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        clearTypingStatus({ data: { conversationId } }).catch(() => {});
        // Also broadcast typing-clear via realtime
        if (draftChannelRef.current) {
          draftChannelRef.current
            .send({
              type: "broadcast",
              event: "typing-clear",
              payload: { userId: meId },
            })
            .catch(() => {});
        }
        return;
      }
      const now = Date.now();
      if (now - lastTypingSentRef.current > 1000) {
        setTypingStatus({ data: { conversationId } }).catch(() => {});
        // Also broadcast typing via realtime for faster indicator
        if (draftChannelRef.current) {
          draftChannelRef.current
            .send({
              type: "broadcast",
              event: "typing",
              payload: { userId: meId },
            })
            .catch(() => {});
        }
        lastTypingSentRef.current = now;
      }
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        clearTypingStatus({ data: { conversationId } }).catch(() => {});
        if (draftChannelRef.current) {
          draftChannelRef.current
            .send({
              type: "broadcast",
              event: "typing-clear",
              payload: { userId: meId },
            })
            .catch(() => {});
        }
      }, 3000);
    },
    [conversationId, setTypingStatus, clearTypingStatus, meId],
  );

  // Broadcast draft text with debounce (~100ms)
  const broadcastDraft = useCallback(
    (currentText: string) => {
      if (!draftPreviewEnabled || !draftChannelRef.current) return;

      // Clear any pending debounce
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current);
        draftDebounceRef.current = null;
      }

      // Only broadcast if text actually changed
      if (currentText === lastDraftTextRef.current) return;
      lastDraftTextRef.current = currentText;

      // Debounce at ~100ms
      draftDebounceRef.current = setTimeout(() => {
        if (!draftChannelRef.current) return;

        const trimmed = currentText.trim();
        if (trimmed) {
          draftChannelRef.current
            .send({
              type: "broadcast",
              event: "draft",
              payload: { userId: meId, text: trimmed },
            })
            .catch(() => {});
        } else {
          draftChannelRef.current
            .send({
              type: "broadcast",
              event: "draft-clear",
              payload: { userId: meId },
            })
            .catch(() => {});
        }
      }, 100);
    },
    [draftPreviewEnabled, meId],
  );

  // Clear draft broadcast when message is sent
  const clearDraftBroadcast = useCallback(() => {
    if (!draftChannelRef.current) return;
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current);
      draftDebounceRef.current = null;
    }
    lastDraftTextRef.current = "";
    draftChannelRef.current
      .send({
        type: "broadcast",
        event: "draft-clear",
        payload: { userId: meId },
      })
      .catch(() => {});
  }, [meId]);

  async function uploadAndSend(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      toast.error("File too large (max 25 MB)");
      return;
    }
    setBusy(true);
    try {
      const { path, token } = await createUpload({
        data: {
          conversationId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
        },
      });
      const { error } = await supabase.storage
        .from("chat-media")
        .uploadToSignedUrl(path, token, file, {
          contentType: file.type || "application/octet-stream",
        });
      if (error) throw error;
      await send({
        data: {
          conversationId,
          media: {
            path,
            mime: file.type || "application/octet-stream",
            name: file.name,
            size: file.size,
            kind: kindForMime(file.type),
          },
        },
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const uploadAndSendMedia = useCallback(
    async (blob: Blob, kind: "image" | "audio" | "video", name: string) => {
      setBusy(true);
      try {
        const { path, token } = await createUpload({
          data: { conversationId, name, mime: blob.type, size: blob.size },
        });
        const { error } = await supabase.storage
          .from("chat-media")
          .uploadToSignedUrl(path, token, blob, { contentType: blob.type });
        if (error) throw error;
        await send({ data: { conversationId, media: { path, mime: blob.type, name, size: blob.size, kind } } });
        if (kind === "audio") setShowVoice(false);
        if (kind === "image" || kind === "video") setShowCamera(false);
      } catch (e: any) {
        toast.error(e?.message ?? "Upload failed");
      } finally {
        setBusy(false);
      }
    },
    [conversationId, createUpload, send],
  );

  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, []);

  async function submit() {
    const content = text.trim();
    if (!content || busy) return;

    if (content.length > MAX_MESSAGE_LENGTH) {
      toast.error("Message cannot exceed 4000 characters.");
      setText(content.slice(0, MAX_MESSAGE_LENGTH));
      return;
    }

    submittingRef.current = true;

    const queryKey = ["messages", conversationId];
    const optimisticId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Build replied_message optimistically so the sender sees the reply preview immediately
    const repliedMessage = replyTo
      ? {
          id: replyTo.id,
          content: replyTo.content,
          message_type: replyTo.message_type,
          media_name: replyTo.media_name,
          sender_id: replyTo.sender_id,
          sender_name:
            replyTo.sender_id === meId
              ? "You"
              : other?.display_name || other?.username || "Other",
        }
      : null;

    const newMessage = {
      id: optimisticId,
      conversation_id: conversationId,
      sender_id: meId,
      content,
      reply_to: replyTo?.id ?? null,
      replied_message: repliedMessage,
      created_at: createdAt,
      message_type: "text" as const,
      is_optimistic: true,
      read_at: null,
      edited: false,
      reactions: [],
      is_saved: false,
      saved_by_me: false,
    };

    clearDraft();
    clearDraftBroadcast();
    queryClient.setQueryData(queryKey, (old: any) => [...(old || []), newMessage]);
    queryClient.setQueryData(["conversations"], (old: any) => {
      if (!Array.isArray(old)) return old;
      return old.map((conv: any) => {
        if (conv.id !== conversationId) return conv;
        return {
          ...conv,
          last: { content, message_type: "text", created_at: createdAt, sender_id: meId },
          last_message_at: createdAt,
          unread: 0,
        };
      });
    });

    setBusy(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    try {
      clearTypingStatus({ data: { conversationId } }).catch(() => {});

      const confirmedMessage = await send({
        data: { conversationId, content, replyTo: replyTo?.id },
      });

      if (confirmedMessage) {
        queryClient.setQueryData(queryKey, (old: any) => {
          const list = (old || []).slice();
          const alreadyHasConfirmed = list.some((item: any) => item.id === confirmedMessage.id);
          if (alreadyHasConfirmed) {
            return list.filter((item: any) => item.id !== optimisticId);
          }

          let replaced = false;
          for (let i = 0; i < list.length; i++) {
            if (list[i].id === optimisticId) {
              list[i] = {
                ...confirmedMessage,
                is_optimistic: false,
                reactions: list[i].reactions ?? confirmedMessage.reactions ?? [],
                is_saved: list[i].is_saved ?? confirmedMessage.is_saved,
                saved_by_me: list[i].saved_by_me ?? confirmedMessage.saved_by_me,
                // Preserve the optimistic replied_message (confirmedMessage also carries it now)
                replied_message: confirmedMessage.replied_message ?? list[i].replied_message ?? null,
              };
              replaced = true;
              break;
            }
          }

          if (!replaced) {
            const confirmedTs = new Date(confirmedMessage.created_at).getTime();
            for (let i = 0; i < list.length; i++) {
              const msg = list[i];
              if (!msg.is_optimistic) continue;
              if (
                msg.sender_id === confirmedMessage.sender_id &&
                msg.content === confirmedMessage.content &&
                (msg.reply_to ?? null) === (confirmedMessage.reply_to ?? null)
              ) {
                const optTs = new Date(msg.created_at).getTime();
                if (Math.abs(optTs - confirmedTs) < 5000) {
                  list[i] = {
                    ...confirmedMessage,
                    is_optimistic: false,
                    reactions: msg.reactions ?? confirmedMessage.reactions ?? [],
                    is_saved: msg.is_saved ?? confirmedMessage.is_saved,
                    saved_by_me: msg.saved_by_me ?? confirmedMessage.saved_by_me,
                    replied_message: confirmedMessage.replied_message ?? msg.replied_message ?? null,
                  };
                  replaced = true;
                  break;
                }
              }
            }
          }

          if (!replaced) {
            list.push(confirmedMessage);
          }
          return list;
        });
      }

      onCancelReply?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Send failed");
      setText(content);
      queryClient.setQueryData(queryKey, (old: any) => {
        return (old || []).map((msg: any) => {
          if (msg.id === optimisticId) {
            return { ...msg, is_optimistic: false, send_failed: true };
          }
          return msg;
        });
      });
    } finally {
      setBusy(false);
      submittingRef.current = false;
      if (isMobile) refocusInput();
    }
  }

  const isMobile = useIsMobile();

  const handleTextChange = useCallback(
    (value: string) => {
      const nextValue = value.length > MAX_MESSAGE_LENGTH ? value.slice(0, MAX_MESSAGE_LENGTH) : value;
      setText(nextValue);
      handleTyping(nextValue);
      broadcastDraft(nextValue);
      if (value.length > MAX_MESSAGE_LENGTH) {
        toast.error("Message cannot exceed 4000 characters.");
      }
    },
    [handleTyping, broadcastDraft],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.nativeEvent.isComposing || busy || !text.trim()) return;

    e.preventDefault();
    void submit();
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) uploadAndSend(f);
      }}
      className="relative p-2 sm:p-6"
      style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
    >
      {drag && (
        <div className="pointer-events-none absolute inset-4 grid place-items-center rounded-2xl border-2 border-dashed border-foreground/30 bg-foreground/5 text-xs uppercase tracking-widest text-foreground/70">
          Drop to send
        </div>
      )}

      {replyTo && (
        <div className="mx-auto mb-2 max-w-4xl px-2 md:px-0">
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 p-2 text-sm shadow-sm backdrop-blur-sm">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <div className="mt-1 size-1 shrink-0 rounded-full bg-primary" />
              <div className="min-w-0 flex-1 break-all whitespace-normal text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
                <span className="font-semibold text-foreground">
                  {replyTo.sender_name ? `${replyTo.sender_name}: ` : ""}
                </span>
                {replyTo.content ?? replyTo.media_name ?? "message"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => onCancelReply?.()}
            >
              <X className="size-3" />
            </Button>
          </div>
        </div>
      )}

      {scheduledMessages.length > 0 && (
        <div className="mx-auto mb-2 max-w-4xl px-2 md:px-0">
          <button
            type="button"
            onClick={() => setScheduleListOpen((open) => !open)}
            className="group flex w-full items-center justify-between rounded-xl border border-primary/20 bg-card/80 px-3 py-2 text-left shadow-sm backdrop-blur transition-all duration-300 hover:border-primary/45 hover:shadow-[0_0_24px_rgba(99,102,241,0.12)]"
            aria-expanded={scheduleListOpen}
          >
            <span className="flex items-center gap-2 text-xs font-medium text-foreground">
              <CalendarClock className="size-4 text-primary transition-transform duration-300 group-hover:-rotate-12" />
              {scheduledMessages.length} scheduled {scheduledMessages.length === 1 ? "message" : "messages"}
            </span>
            <ChevronUp className={cn("size-4 text-muted-foreground transition-transform duration-300", !scheduleListOpen && "rotate-180")} />
          </button>
          <div className={cn("grid transition-[grid-template-rows,opacity] duration-300", scheduleListOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
            <div className="min-h-0 overflow-hidden">
              <div className="mt-2 space-y-2 rounded-xl border border-border/70 bg-card/90 p-2 shadow-lg backdrop-blur-xl">
                {scheduledMessages.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-foreground">{item.content}</p>
                      <p className="mt-0.5 text-[10px] text-primary">{new Date(item.scheduled_for).toLocaleString()}</p>
                    </div>
                    <button type="button" onClick={() => openSchedule(item.content, item)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary" aria-label="Edit scheduled message">
                      <Pencil className="size-3.5" />
                    </button>
                    <button type="button" onClick={() => void handleCancelScheduled(item.id)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive" aria-label="Cancel scheduled message">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="relative mx-auto flex max-w-4xl items-end gap-1.5 rounded-2xl bg-card/80 p-1.5 ring-1 ring-border backdrop-blur sm:gap-2 sm:p-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 sm:size-10"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Attach"
        >
          <Paperclip className="size-4" />
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadAndSend(f);
            e.currentTarget.value = "";
          }}
        />
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onFocus={() => {
            setIsFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            if (submittingRef.current) return;
            setIsFocused(false);
            onBlur?.();
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
            clearTypingStatus({ data: { conversationId } }).catch(() => {});
            clearDraftBroadcast();
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type a message…"
          maxLength={MAX_MESSAGE_LENGTH}
          className="min-h-[40px] flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-sm focus-visible:ring-0 sm:py-2"
        />

        <EmojiPickerWrapper text={text} setText={setText} />

        {!text.trim() && !busy && (
          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 sm:size-10 text-muted-foreground hover:text-primary"
              onClick={() => setShowCamera(true)}
              aria-label="Camera"
            >
              <Camera className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 sm:size-10 text-muted-foreground hover:text-primary"
              onClick={() => setShowVoice(true)}
              aria-label="Voice Note"
            >
              <Mic className="size-4" />
            </Button>
          </div>
        )}

        {text.trim() && (
          <Button
            type="button"
            onPointerDown={handleSendPointerDown}
            onPointerUp={clearSendHold}
            onPointerLeave={clearSendHold}
            onContextMenu={(event) => {
              event.preventDefault();
              clearSendHold();
              openSchedule();
            }}
            onClick={() => {
              if (longPressTriggeredRef.current) {
                longPressTriggeredRef.current = false;
                return;
              }
              void submit();
            }}
            disabled={busy || !text.trim()}
            className={cn("h-8 rounded-xl px-3 sm:h-10 sm:px-4 sm:gap-1.5")}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            <span className="hidden text-[11px] font-bold uppercase tracking-wider sm:inline-block">Send</span>
          </Button>
        )}
      </div>

      <div className={cn("pointer-events-none absolute inset-x-2 bottom-full z-50 mb-2 origin-bottom transition-all duration-300 sm:inset-x-6", scheduleOpen ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-95 opacity-0")}>
        <div className="pointer-events-auto mx-auto max-w-md rounded-2xl border border-primary/25 bg-card/95 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.24),0_0_30px_rgba(99,102,241,0.12)] backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground"><CalendarClock className="size-4 text-primary" /> {editingSchedule ? "Edit schedule" : "Schedule message"}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Only you can see pending scheduled messages.</p>
            </div>
            <button type="button" onClick={closeSchedule} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close scheduling">
              <X className="size-4" />
            </button>
          </div>
          <textarea
            value={scheduleContent}
            onChange={(event) => setScheduleContent(event.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            rows={2}
            className="w-full resize-none rounded-xl border border-border bg-background/70 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder="Message to schedule"
          />
          <div className="mt-3 flex items-center gap-2">
            <input
              type="datetime-local"
              value={scheduleTime}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              onChange={(event) => setScheduleTime(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              aria-label="Schedule time"
            />
            <button type="button" onClick={() => void submitSchedule()} disabled={scheduleBusy || !scheduleContent.trim() || !scheduleTime} className="rounded-xl brand-gradient px-3 py-2 text-xs font-semibold text-white shadow-[0_0_18px_rgba(99,102,241,0.28)] transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50">
              {scheduleBusy ? <Loader2 className="size-4 animate-spin" /> : editingSchedule ? "Update" : "Schedule"}
            </button>
          </div>
        </div>
      </div>

      {showVoice && (
        <div className="absolute inset-x-2 bottom-2 z-40 sm:inset-x-6 sm:bottom-6">
          <VoiceRecorder
            onCancel={() => setShowVoice(false)}
            onSend={(blob) => uploadAndSendMedia(blob, "audio", `voice-${Date.now()}.webm`)}
          />
        </div>
      )}

      {showCamera && (
        <CameraCapture
          onClose={() => setShowCamera(false)}
          onCapture={(blob, kind) => uploadAndSendMedia(blob, kind, `capture-${Date.now()}.jpg`)}
        />
      )}
    </div>
  );
}

function EmojiPickerWrapper({ text, setText }: { text: string; setText: (t: string | ((prev: string) => string)) => void }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const onEmoji = (d: any) => {
    setText((t) => t + d.emoji);
    if (!isMobile) setOpen(false);
  };

  const picker = (
    <EmojiPicker
      className="!border-none !shadow-none"
      width="100%"
      height={isMobile ? 350 : 400}
      theme={
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark")
          ? EmojiTheme.DARK
          : EmojiTheme.LIGHT
      }
      onEmojiClick={onEmoji}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button type="button" size="icon" variant="ghost" className="size-8">
            <Smile className="size-4" />
          </Button>
        </DrawerTrigger>
        <DrawerContent className="p-0">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Emoji Picker</DrawerTitle>
          </DrawerHeader>
          <div className="p-1 pb-4">
            {picker}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="icon" variant="ghost" className="size-10">
          <Smile className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-auto border-none p-0 shadow-2xl">
        {picker}
      </PopoverContent>
    </Popover>
  );
}
