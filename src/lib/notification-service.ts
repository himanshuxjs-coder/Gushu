import { supabase } from "@/integrations/supabase/client";
import { subscribeWithReconnect } from "@/lib/realtime-utils";
import { toast } from "sonner";
import { PushNotifications, Token } from "@capacitor/push-notifications";
import { Capacitor } from "@capacitor/core";

// Use a tiny local WebAudio chirp instead of downloading a remote MP3 on every notification.
// This keeps the app responsive, reduces external egress, and still gives a distinct alert.
export function playNotificationSound() {
  try {
    const AudioCtxCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxCtor) return;

    const audioCtx = new AudioCtxCtor();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.value = 760;
    gainNode.gain.value = 0.0001;

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    oscillator.start(now);
    gainNode.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    oscillator.stop(now + 0.28);

    oscillator.onended = () => {
      void audioCtx.close().catch(() => {});
    };
  } catch {
    // The browser may block audio in some cases. Silent failure is acceptable.
  }
}

// Request notification permission
export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) {
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    return false;
  }

  const permission = await Notification.requestPermission();
  return permission === "granted";
}

function shouldSuppressNotificationForConversation(conversationId?: string | null): boolean {
  if (!conversationId) return false;
  return isConversationActive(conversationId);
}

// Show privacy-safe notification
export async function showPrivacyNotification(
  conversationId: string,
  options?: {
    tag?: string;
    requireInteraction?: boolean;
    title?: string;
    body?: string;
  }
): Promise<Notification | null> {
  // Suppress notifications whenever the user is on a chat route
  if (shouldSuppressNotificationForConversation(conversationId)) {
    return null;
  }

  // Always play sound for new messages
  playNotificationSound();

  // If app is visible, show in-app toast instead of native notification
  if (document.visibilityState === "visible") {
    toast(options?.title ?? "Gushu", {
      description: options?.body ?? "Knock Knock! 👀",
      action: {
        label: "Open app",
        onClick: () => {
          window.location.href = "/app";
        },
      },
    });
    return null;
  }

  // Android/iOS FCM is responsible for background and killed-app delivery.
  // Do not create a second browser notification from the realtime subscription.
  if (Capacitor.isNativePlatform()) {
    return null;
  }

  const hasPermission = await requestNotificationPermission();
  if (!hasPermission) return null;

  try {
    const notification = new Notification("Gushu", {
      body: options?.body ?? "Knock Knock! 👀",
      requireInteraction: options?.requireInteraction ?? false,
      silent: false, // We're playing our own sound too
      renotify: true,
    } as any);

    notification.onclick = () => {
      window.focus();
      notification.close();
      window.location.href = "/app";
    };

    return notification;
  } catch (err) {
    console.error("Failed to show notification:", err);
    return null;
  }
}

// Global notification subscription state
let globalChannel: ReturnType<typeof supabase.channel> | null = null;
let globalUserId: string | null = null;
let globalCleanupFn: (() => void) | null = null;
let activeConversationId: string | null = null;
let pushListenersRegistered = false;
let pushRegistrationUserId: string | null = null;

export function setActiveConversationId(conversationId: string | null) {
  activeConversationId = conversationId;
}

function getActiveConversationIdFromPath() {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/\/app\/c\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function isConversationActive(conversationId: string) {
  if (!conversationId) return false;
  if (typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus())) {
    return false;
  }
  if (activeConversationId === conversationId) return true;

  const activePathConversationId = getActiveConversationIdFromPath();
  return activePathConversationId === conversationId;
}

export function subscribeToMessageNotifications(
  userId: string,
  onNewMessage: (conversationId: string) => void,
  onUpdate?: (conversationId: string) => void
): () => void {
  // Prevent duplicate subscriptions for same user (only if channel is healthy)
  if (globalChannel && globalUserId === userId) {
    const state = (globalChannel as any).state;
    if (state === "joined" || state === "joining") {
      return () => {};
    }
    // Channel exists but is in error/closed state — clean up and re-subscribe
    try { supabase.removeChannel(globalChannel); } catch {}
    globalChannel = null;
  }

  // Clean up any existing subscription
  if (globalChannel) {
    supabase.removeChannel(globalChannel);
    globalChannel = null;
    globalUserId = null;
  }

  globalUserId = userId;

  globalChannel = supabase
    .channel(`notifications:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
      },
      async (payload) => {
        const message = payload.new as any;
        if (message.sender_id === userId) return;

        // Suppress notifications immediately when the matching chat is already open
        if (isConversationActive(message.conversation_id)) {
          return;
        }

        // Check notification settings for this conversation
        try {
          const { data: settings, error } = await supabase
            .from("conversation_settings")
            .select("notification_enabled")
            .eq("conversation_id", message.conversation_id)
            .eq("user_id", userId)
            .maybeSingle();

          if (error) return;

          // Notify by default unless explicitly disabled
          if (settings?.notification_enabled !== false) {
            await showPrivacyNotification(message.conversation_id);
            onNewMessage(message.conversation_id);
            if (onUpdate) onUpdate(message.conversation_id);
          }
        } catch {
          // Silent fail - don't crash on notification errors
        }
      }
    );

  subscribeWithReconnect(globalChannel);

  return () => {
    if (globalChannel) {
      supabase.removeChannel(globalChannel);
      globalChannel = null;
      globalUserId = null;
    }
  };
}

// Initialize notifications globally on app load
export function initializeGlobalNotifications(
  userId: string,
  onUpdate?: (conversationId: string) => void
): () => void {
  if (globalCleanupFn) {
    globalCleanupFn();
    globalCleanupFn = null;
  }

  // Handle Push Notifications for Mobile
  if (Capacitor.isNativePlatform()) {
    initializePushNotifications(userId);
  } else {
    // Request permission early for Web
    requestNotificationPermission().catch(() => { });
  }

  globalCleanupFn = subscribeToMessageNotifications(userId, (conversationId) => {
    console.log("New message notification for:", conversationId);
  }, onUpdate);

  return globalCleanupFn;
}

export function initializePushNotifications(userId: string) {
  if (!Capacitor.isNativePlatform() || pushRegistrationUserId === userId) return;

  pushRegistrationUserId = userId;
  void registerPushNotifications(userId);
}

async function registerPushNotifications(userId: string) {
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || authData.user?.id !== userId) {
      console.warn("[Push] FCM registration skipped: authenticated session is unavailable", authError);
      return;
    }

    console.log("[Push] Initializing Firebase Messaging through Capacitor");
    let permStatus = await PushNotifications.checkPermissions();
    console.log("[Push] Notification permission status:", permStatus.receive);

    if (permStatus.receive === "prompt") {
      console.log("[Push] Requesting Android notification permission");
      permStatus = await PushNotifications.requestPermissions();
      console.log("[Push] Notification permission result:", permStatus.receive);
    }

    if (permStatus.receive !== "granted") {
      console.warn("[Push] Notification permission denied; FCM registration skipped");
      return;
    }

    if (Capacitor.getPlatform() === "android") {
      await PushNotifications.createChannel({
        id: "gushu-message-v2",
        name: "Gushu Messages",
        description: "Incoming Gushu messages and alerts",
        importance: 5,
        visibility: 1,
        sound: "gushu_notification",
        vibration: true,
      });
    }

    if (!pushListenersRegistered) {
      await PushNotifications.addListener("registration", (token: Token) => {
        const previousToken = localStorage.getItem("fcm_token");
        console.log(
          previousToken && previousToken !== token.value
            ? "[Push] FCM token refreshed"
            : "[Push] FCM registration token received",
        );
        void savePushToken(userId, token.value);
      });

      await PushNotifications.addListener("registrationError", (error: unknown) => {
        console.error("[Push] FCM registration error:", error);
      });

      await PushNotifications.addListener("pushNotificationReceived", (notification) => {
        console.log("Push notification received: ", notification);
        const conversationId =
          (notification.data as Record<string, string | undefined> | undefined)?.conversation_id ??
          (notification.notification?.data as Record<string, string | undefined> | undefined)?.conversation_id;

        if (shouldSuppressNotificationForConversation(conversationId)) {
          console.log("[Push] Suppressed native notification for active conversation:", conversationId);
          return;
        }

        // Capacitor delivers foreground FCM messages to this listener instead of
        // showing an Android system notification. Keep that behavior in-app.
        playNotificationSound();
        toast(notification.title || "Gushu", {
          description: notification.body || "New message!",
        });
      });

      await PushNotifications.addListener("pushNotificationActionPerformed", (notification) => {
        console.log("Push notification action performed", notification.actionId, notification.notification);
        const conversationId =
          (notification.notification?.data as Record<string, string | undefined> | undefined)?.conversation_id ??
          (notification.data as Record<string, string | undefined> | undefined)?.conversation_id;
        if (conversationId) {
          window.location.href = `/app/c/${conversationId}`;
          return;
        }
        window.location.href = "/app";
      });

      pushListenersRegistered = true;
    }

    console.log("[Push] Starting Firebase Messaging registration");
    await PushNotifications.register();
  } catch (error) {
    console.error("[Push] FCM initialization or registration failed:", error);
  }
}

async function savePushToken(userId: string, token: string) {
  try {
    let session = null;
    let authError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await supabase.auth.getSession();
      session = result.data.session;
      authError = result.error;
      if (session?.user.id === userId && session.access_token) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(
      "[Push] Supabase session before token registration:",
      JSON.stringify({
        hasSession: Boolean(session),
        hasAccessToken: Boolean(session?.access_token),
        sessionUserId: session?.user.id ?? null,
        expectedUserId: userId,
        authError,
      }),
    );

    if (!session || session.user.id !== userId || !session.access_token) {
      console.warn("[Push] Token registration skipped: authenticated session is unavailable");
      return;
    }

    const previousToken = localStorage.getItem("fcm_token");
    if (previousToken && previousToken !== token) {
      console.log("[Push] Removing previous FCM token before registering refreshed token");
      const { data, error } = await supabase.rpc("unregister_push_token", {
        p_token: previousToken,
      });
      console.log("[Push] unregister_push_token result:", JSON.stringify({ data, error }));
    }

    console.log("[Push] Registering FCM token with Supabase");
    const { data, error } = await supabase.rpc("register_push_token", {
      p_token: token,
      p_device_type: "android",
    });
    console.log("[Push] register_push_token result:", JSON.stringify({ data, error }));

    if (error || (Array.isArray(data) && data[0]?.success === false)) {
      console.warn("[Push] register_push_token failed; trying refreshed RPC endpoint", error ?? data);
      const fallback = await supabase.rpc("register_push_token_v2" as never, {
        p_token: token,
        p_device_type: "android",
      } as never);
      console.log("[Push] register_push_token_v2 result:", JSON.stringify(fallback));
      if (fallback.error || (Array.isArray(fallback.data) && fallback.data[0]?.success === false)) {
        console.warn("[Push] RPC fallback unavailable; trying authenticated token upsert");
        const directRegistration = await supabase.from("user_push_tokens").upsert(
          {
            user_id: userId,
            token,
            device_type: "android",
          },
          { onConflict: "token" },
        );
        console.log(
          "[Push] Direct user_push_tokens upsert result:",
          JSON.stringify(directRegistration),
        );
        if (directRegistration.error) {
          console.error("[Push] FCM token registration failed:", directRegistration.error);
          return;
        }
      }
    }

    localStorage.setItem("fcm_token", token);
  } catch (error) {
    console.error("[Push] FCM token registration error:", error);
  }
}

// Cleanup push notifications for this device on logout via RPC
export async function unregisterPushNotifications() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const token = localStorage.getItem("fcm_token");
    if (token) {
      console.log("[Push] Unregistering FCM token before logout");
      const { data, error } = await supabase.rpc("unregister_push_token", {
        p_token: token,
      });
      console.log("[Push] unregister_push_token result:", { data, error });
      if (error) console.error("[Push] Error unregistering push token:", error);
      localStorage.removeItem("fcm_token");
    }

    await PushNotifications.removeAllListeners();
    pushListenersRegistered = false;
    pushRegistrationUserId = null;
    console.log("[Push] Firebase Messaging listeners removed");
  } catch (error) {
    console.error("[Push] Logout token cleanup failed:", error);
  }
}
