// ============================================================
// JobToast
//
// Floating banner that surfaces completion of background jobs
// (meal-plan generation, "Add to Calendar" confirmation). Slides
// in from the bottom; tap navigates to the relevant tab.
//
// Lives at the root so it persists across tab switches.
// ============================================================

import { useBackgroundJobs } from '@/contexts/BackgroundJobsContext';
import { Radius, Shadows, Spacing } from '@/constants/theme';
import { useTheme } from '@/contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

const AUTO_HIDE_MS = 8000;

type ToastDescriptor = {
  variant: 'success' | 'error';
  title: string;
  subtitle: string;
  iconName: 'checkmark-circle' | 'alert-circle';
  onPress: () => void;
  onDismiss: () => void;
};

export default function JobToast() {
  const { colors } = useTheme();
  const router = useRouter();
  const {
    generation,
    confirm,
    acknowledgeGeneration,
    acknowledgeConfirm,
    clearConfirm,
  } = useBackgroundJobs();

  // Pick which job (if any) currently wants to surface a toast.
  // Generation takes precedence — it lands first.
  const descriptor: ToastDescriptor | null = useMemo(() => {
    if ((generation.status === 'done' || generation.status === 'error') && !generation.acknowledged) {
      if (generation.status === 'done') {
        return {
          variant: 'success',
          title: 'Recipes ready',
          subtitle: 'Tap to review your meal plan',
          iconName: 'checkmark-circle',
          onPress: () => {
            acknowledgeGeneration();
            router.push('/(tabs)/generate');
          },
          onDismiss: acknowledgeGeneration,
        };
      }
      return {
        variant: 'error',
        title: 'Generation failed',
        subtitle: generation.error,
        iconName: 'alert-circle',
        onPress: () => {
          acknowledgeGeneration();
          router.push('/(tabs)/generate');
        },
        onDismiss: acknowledgeGeneration,
      };
    }
    if ((confirm.status === 'done' || confirm.status === 'error') && !confirm.acknowledged) {
      if (confirm.status === 'done') {
        return {
          variant: 'success',
          title: 'Shopping list ready',
          subtitle: 'Tap to view your shopping list',
          iconName: 'checkmark-circle',
          onPress: () => {
            clearConfirm();
            router.push('/(tabs)/shopping');
          },
          onDismiss: clearConfirm,
        };
      }
      return {
        variant: 'error',
        title: 'Save failed',
        subtitle: confirm.error,
        iconName: 'alert-circle',
        onPress: () => {
          acknowledgeConfirm();
          router.push('/(tabs)/generate');
        },
        onDismiss: acknowledgeConfirm,
      };
    }
    return null;
  }, [generation, confirm, acknowledgeGeneration, acknowledgeConfirm, clearConfirm, router]);

  const slide = useState(() => new Animated.Value(120))[0];
  const opacity = useState(() => new Animated.Value(0))[0];

  useEffect(() => {
    if (!descriptor) {
      slide.setValue(120);
      opacity.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.timing(slide, { toValue: 0, duration: 240, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }),
    ]).start();

    const t = setTimeout(() => {
      descriptor.onDismiss();
    }, AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [descriptor, slide, opacity]);

  if (!descriptor) return null;

  const bg = descriptor.variant === 'success' ? colors.primary : colors.error;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.host, { transform: [{ translateY: slide }], opacity }]}
    >
      <Pressable
        onPress={descriptor.onPress}
        style={[styles.toast, { backgroundColor: bg }, Shadows.lg]}
      >
        <Ionicons name={descriptor.iconName} size={22} color="#fff" />
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>{descriptor.title}</Text>
          <Text style={styles.subtitle} numberOfLines={2}>{descriptor.subtitle}</Text>
        </View>
        <Pressable
          onPress={descriptor.onDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.closeBtn}
        >
          <Ionicons name="close" size={18} color="#fff" />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    bottom: 96, // sits above the tab bar
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    gap: Spacing.md,
  },
  textCol: { flex: 1 },
  title: { color: '#fff', fontWeight: '700', fontSize: 15 },
  subtitle: { color: '#fff', opacity: 0.9, fontSize: 13, marginTop: 2 },
  closeBtn: { padding: 4 },
});
