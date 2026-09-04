import { useEffect } from 'react';
import { PushNotifications, type Token } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { supabase } from "@/integrations/supabase/client";

export const usePushNotifications = (userId: string | undefined) => {
  useEffect(() => {
    if (!userId || !Capacitor.isNativePlatform()) return;

    const registerPush = async () => {
      try {
        let permStatus = await PushNotifications.checkPermissions();

        if (permStatus.receive === 'prompt') {
          permStatus = await PushNotifications.requestPermissions();
        }

        if (permStatus.receive !== 'granted') {
          console.warn('Push notification permission denied');
          return;
        }

        if (Capacitor.getPlatform() === 'android') {
          await PushNotifications.createChannel({
            id: 'gushu-priority-v1',
            name: 'Gushu High Priority',
            description: 'Important notifications that show over other apps',
            importance: 5,
            visibility: 1,
            sound: 'default',
            vibration: true,
          });
        }

        await PushNotifications.register();
      } catch (error) {
        console.error('Error registering push notifications:', error);
      }
    };

    const saveToken = async (token: string) => {
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();

    console.log("========== PUSH DEBUG ==========");
    console.log("Authenticated user:", authData.user);
    console.log("Auth error:", authError);
    console.log("User ID from hook:", userId);
    console.log("FCM Token:", token);

    if (!authData.user) {
      console.error("No authenticated user. Token registration aborted.");
      return;
    }

    localStorage.setItem("fcm_token", token);

    const info = await Device.getInfo();

    const { data, error } = await supabase.rpc("register_push_token", {
      p_token: token,
      p_device_type:
        info.platform === "android"
          ? "android"
          : info.platform === "ios"
          ? "ios"
          : "web",
    });

    console.log("RPC Response:", data);
    console.log("RPC Error:", error);

    if (data && Array.isArray(data) && !data[0]?.success) {
      console.error("RPC returned failure:", data[0].message);
    }
  } catch (error) {
    console.error("saveToken failed:", error);
  }
};

    // const saveToken = async (token: string) => {
    //   try {
    //     // Store token locally for cleanup on logout
    //     localStorage.setItem("fcm_token", token);

    //     const info = await Device.getInfo();
    //     const { error } = await supabase.rpc('register_push_token' as any, {
    //       p_token: token,
    //       p_device_type: info.platform === 'android' ? 'android' : info.platform === 'ios' ? 'ios' : 'web'
    //     });

    //     if (error) {
    //       console.error('Error registering push token via RPC:', error);
    //     }
    //   } catch (error) {
    //     console.error('Error in saveToken:', error);
    //   }
    // };

    // Listeners
    const addListeners = async () => {
      await PushNotifications.addListener('registration', (token: Token) => {
        console.log('Push registration success, token:', token.value);
        saveToken(token.value);
      });

      await PushNotifications.addListener('registrationError', (error: any) => {
        console.error('Push registration error:', error);
      });

      await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('Push notification received:', notification);
      });

      await PushNotifications.addListener('pushNotificationActionPerformed', (notification) => {
        console.log('Push notification action performed:', notification);
        // You could navigate to the conversation here if notification.data.conversation_id exists
      });
    };

    addListeners();
    registerPush();

    return () => {
      PushNotifications.removeAllListeners();
    };
  }, [userId]);
};
