import { notifications as Notifications } from '@/services/notifications';
import type * as NotificationTypes from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'expo-router';
import { logEvent } from '@/services/devLog';

// Show notifications even when app is foregrounded (so in-app toast and OS
// notification don't conflict — the context guards against firing OS
// notifications when active, so this only matters for edge cases).
//
// Wrapped in try/catch because this runs at module-import time. If the native
// notifications module isn't ready (or rejects the handler shape on this SDK
// version), throwing here would crash the JS bundle on load — which would
// brick the entire app rather than just notifications.
try {
  Notifications?.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch (err) {
  logEvent('warn', 'setNotificationHandler', err);
}

export function useNotifications() {
  const router = useRouter();
  const {householdId,loading}=useAuth();
  const handled=useRef<string|null>(null);

  // Permission request + Android channel creation (once on app start)
  useEffect(() => {
    async function setup() {
      if (!Notifications) return;
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('mealwizard-jobs', {
          name: 'Meal Plan Jobs',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
        });
      }
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        await Notifications.requestPermissionsAsync();
      }
    }
    setup().catch((err) => logEvent('warn', 'useNotifications.setup', err));
  }, []);

  // Notification tap → navigate to the relevant tab
  useEffect(() => {
    if(!Notifications||loading||!householdId)return;
    const open=(response:NotificationTypes.NotificationResponse)=>{
      if(handled.current===response.notification.request.identifier)return;
      handled.current=response.notification.request.identifier;
      const data = response.notification.request.content.data as Record<string, string>;
      void Notifications?.clearLastNotificationResponseAsync().catch(()=>{});
      if(data.householdId&&data.householdId!==householdId){Alert.alert('Different household','Switch to the household for this reminder to open its planned meal.');return;}
      if (data?.navigateTo === 'generate') router.push('/(tabs)/generate');
      else if (data?.navigateTo === 'shopping') router.push('/(tabs)/shopping');
      else if (data?.navigateTo === 'cookbook') router.push('/(tabs)/cookbook');
      else if (data?.navigateTo === 'plan') router.push({ pathname: '/', params: { mealId: data.mealId } });
      else if (data?.navigateTo === 'cook') router.push({ pathname: '/cook', params: { mealId: data.mealId, recipeId: data.recipeId } });
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    let active=true;
    Notifications.getLastNotificationResponseAsync().then(response=>{if(response&&active)open(response);}).catch(()=>{});
    return () => {active=false;sub.remove();};
  }, [router,householdId,loading]);
}
