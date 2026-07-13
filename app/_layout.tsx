import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { BackgroundJobsProvider } from '@/contexts/BackgroundJobsContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { DeveloperModeProvider } from '@/contexts/DeveloperModeContext';
import JobToast from '@/components/JobToast';
import { useNotifications } from '@/hooks/useNotifications';

import * as SplashScreen from 'expo-splash-screen';
import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  useFonts,
} from '@expo-google-fonts/outfit';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { user, loading, householdId } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { colors } = useTheme();
  useNotifications();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'login' || segments[0] === 'register';
    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && householdId && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, householdId, segments]);

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="(tabs)" />
      </Stack>
      <JobToast />
      <StatusBar style="auto" />
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
        <DeveloperModeProvider>
          <BackgroundJobsProvider>
            <RootNavigator />
          </BackgroundJobsProvider>
        </DeveloperModeProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
