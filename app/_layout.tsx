import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { ConnectedProvider } from '@/contexts/ConnectedContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { DeveloperModeProvider } from '@/contexts/DeveloperModeContext';
import { useNotifications } from '@/hooks/useNotifications';
import { useMealReminderSync } from '@/hooks/useMealReminderSync';

import * as SplashScreen from 'expo-splash-screen';
import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  useFonts,
} from '@expo-google-fonts/outfit';

SplashScreen.preventAutoHideAsync();

/** Shown by Expo Router instead of a blank screen when a screen crashes. */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <View style={styles.crash}>
      <Text accessibilityRole="header" style={styles.crashTitle}>Something went wrong</Text>
      <Text style={styles.crashBody}>
        Your plan and shopping list are safe. Try again, and if this keeps happening, close and reopen the app.
      </Text>
      <Text style={styles.crashDetail} numberOfLines={3}>{error.message}</Text>
      <Pressable accessibilityRole="button" onPress={retry} style={styles.crashButton}>
        <Text style={styles.crashButtonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function RootNavigator() {
  const { user, loading, householdId } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { colors, effectiveScheme } = useTheme();
  useNotifications();
  useMealReminderSync();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'login' || segments[0] === 'register';
    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && householdId && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, householdId, segments, router]);

  if (loading) {
    return (
      <>
        <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
        <StatusBar style={effectiveScheme === 'light' ? 'dark' : 'light'} />
      </>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="(tabs)" />
      </Stack>
      <StatusBar style={effectiveScheme === 'light' ? 'dark' : 'light'} />
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
    Outfit_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <ConnectedProvider>
        <DeveloperModeProvider>
          <RootNavigator />
        </DeveloperModeProvider>
        </ConnectedProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  crash: { flex: 1, justifyContent: 'center', padding: 32, gap: 16, backgroundColor: '#F2EAD3' },
  crashTitle: { fontSize: 24, fontWeight: '700', color: '#1F2A1F' },
  crashBody: { fontSize: 16, lineHeight: 22, color: '#1F2A1F' },
  crashDetail: { fontSize: 13, color: '#5C665C' },
  crashButton: { minHeight: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', backgroundColor: '#2F5D3A' },
  crashButtonText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
