import { supabase } from "@/integrations/supabase/client";
import { subscribeWithReconnect } from "@/lib/realtime-utils";
import { toast } from "sonner";
import { PushNotifications, Token, PermissionStatus } from "@capacitor/push-notifications";
import { Device } from "@capacitor/device";
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
  if (isConversationActive(conversationId)) {
    return null;
  }

  // Always play sound for new messages
  playNotificationSound();

  // If app is visible, show in-app toast instead of native notification
  if (document.visibilityState === "visible") {
    toast(options?.title ?? "Gushu", {
      description: options?.body ?? "Knock Knock! 👀",
      action: {
        label: "View",
        onClick: () => {
          window.location.href = `/app/c/${conversationId}`;
        },
      },
    });
    return null;
  }

  const hasPermission = await requestNotificationPermission();
  if (!hasPermission) return null;

  try {
    const notification = new Notification("Gushu", {
      body: options?.body ?? "Knock Knock! 👀",
      tag: options?.tag ?? conversationId,
      requireInteraction: options?.requireInteraction ?? false,
      silent: false, // We're playing our own sound too
      renotify: true,
    } as any);

    notification.onclick = () => {
      window.focus();
      notification.close();
      window.location.href = `/app/c/${conversationId}`;
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
    registerPushNotifications(userId).catch(console.error);
  } else {
    // Request permission early for Web
    requestNotificationPermission().catch(() => { });
  }

  globalCleanupFn = subscribeToMessageNotifications(userId, (conversationId) => {
    console.log("New message notification for:", conversationId);
  }, onUpdate);

  return globalCleanupFn;
}

async function registerPushNotifications(userId: string) {
  let permStatus: PermissionStatus = await PushNotifications.checkPermissions();

  if (permStatus.receive === "prompt") {
    permStatus = await PushNotifications.requestPermissions();
  }

  if (permStatus.receive !== "granted") {
    console.warn("User denied push notification permissions");
    return;
  }

  // Create a default notification channel for Android
  if (Capacitor.getPlatform() === 'android') {
    await PushNotifications.createChannel({
      id: 'gushu-priority-v1',
      name: 'Gushu High Priority',
      description: 'Important notifications that show over other apps',
      importance: 5, // Max importance for heads-up
      visibility: 1, // Public
      sound: 'default',
      vibration: true,
    });
  }

  await PushNotifications.addListener("registration", async (token: Token) => {
    console.log("Push registration success, token:", token.value);
    
    // Store token locally for cleanup on logout
    localStorage.setItem("fcm_token", token.value);
    
    // Get device info
    const info = await Device.getInfo();
    
    // Register token via RPC (Strictly no direct table access)
    const { error } = await supabase.rpc("register_push_token" as any, {
      p_token: token.value,
      p_device_type: info.platform // 'android' or 'ios'
    });

    if (error) {
      console.error("Error registering push token via RPC:", error);
    }
  });

  await PushNotifications.addListener("registrationError", (error: any) => {
    console.error("Error on registration: " + JSON.stringify(error));
  });

  await PushNotifications.addListener("pushNotificationReceived", (notification) => {
    console.log("Push notification received: ", notification);
    const conversationId = notification.data?.conversation_id as string | undefined;
    if (conversationId && isConversationActive(conversationId)) {
      return;
    }

    // On foreground, we might want to manually show a toast or sound
    playNotificationSound();
    toast(notification.title || "Gushu", {
      description: notification.body || "New message!",
    });
  });

  await PushNotifications.addListener("pushNotificationActionPerformed", (notification) => {
    console.log("Push notification action performed", notification.actionId, notification.notification);
    const conversationId = notification.notification.data?.conversation_id;
    if (conversationId) {
      window.location.href = `/app/c/${conversationId}`;
    }
  });

  // Native registration may complete immediately. Register listeners first so
  // the FCM token cannot be lost before it is stored in Supabase.
  await PushNotifications.register();
}

// Cleanup push notifications for this device on logout via RPC
export async function unregisterPushNotifications() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const token = localStorage.getItem("fcm_token");
    if (token) {
      console.log("Unregistering push token via RPC:", token);
      const { error } = await supabase.rpc("unregister_push_token" as any, {
        p_token: token
      });
      
      if (error) {
        console.error("Error unregistering push token:", error);
      }
      
      localStorage.removeItem("fcm_token");
    }

    // Stop listening
    await PushNotifications.removeAllListeners();
    console.log("Push notifications cleanup complete");
  } catch (error) {
    console.error("Error in unregisterPushNotifications:", error);
  }
}
