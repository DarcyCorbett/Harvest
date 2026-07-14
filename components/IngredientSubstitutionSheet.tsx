// ============================================================
// Meal Wizard — Ingredient Substitution Flyout
// Compact slide-up drawer for showing ingredient replacements.
// ============================================================

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Animated,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
  PanResponder,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { getIngredientSubstitutions, type SubstitutionResult } from '@/services/substitutions';
import type { Ingredient } from '@/services/types';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.55; // Slightly over half height for substitution content

interface Props {
  ingredient: Ingredient | null;
  recipeTitle: string;
  allIngredients: string[];
  visible: boolean;
  onClose: () => void;
}

export default function IngredientSubstitutionSheet({
  ingredient,
  recipeTitle,
  allIngredients,
  visible,
  onClose,
}: Props) {
  const { householdId } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [substitutions, setSubstitutions] = useState<SubstitutionResult[]>([]);

  // Animation values
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  // Pulse animation for skeleton loading
  const skeletonAlpha = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    if (loading) {
      anim = Animated.loop(
        Animated.sequence([
          Animated.timing(skeletonAlpha, {
            toValue: 0.7,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(skeletonAlpha, {
            toValue: 0.3,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      anim.start();
    } else {
      skeletonAlpha.setValue(0.3);
    }
    return () => {
      if (anim) anim.stop();
    };
  }, [loading, skeletonAlpha]);

  // Load substitutions
  const fetchSubstitutions = useCallback(async () => {
    if (!ingredient) return;
    setLoading(true);
    setError(null);
    try {
      const results = await getIngredientSubstitutions(
        householdId ?? '',
        ingredient.name,
        ingredient.unit,
        recipeTitle,
        allIngredients
      );
      setSubstitutions(results);
    } catch (err: any) {
      setError(err?.message || 'Could not fetch substitutes. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [householdId, ingredient, recipeTitle, allIngredients]);

  // Animate in / out
  useEffect(() => {
    if (visible && ingredient) {
      // Clear previous suggestions first
      setSubstitutions([]);
      setError(null);
      
      // Animate sheet in
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          tension: 55,
          friction: 10,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();

      fetchSubstitutions();
    } else {
      // Animate out
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: SHEET_HEIGHT,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, ingredient, fetchSubstitutions, translateY, backdropOpacity]);

  const closeSheet = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SHEET_HEIGHT,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  };

  // Swipe-to-dismiss gesture handling (handle area only)
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) {
          translateY.setValue(gs.dy);
          backdropOpacity.setValue(Math.max(0, 1 - gs.dy / (SHEET_HEIGHT * 0.7)));
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 80 || gs.vy > 0.5) {
          closeSheet();
        } else {
          Animated.parallel([
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
            Animated.timing(backdropOpacity, { toValue: 1, duration: 120, useNativeDriver: true }),
          ]).start();
        }
      },
    })
  ).current;

  if (!visible || !ingredient) return null;

  return (
    <View style={StyleSheet.absoluteFillObject}>
      {/* Backdrop (semi-transparent overlay) */}
      <TouchableOpacity
        style={StyleSheet.absoluteFillObject}
        activeOpacity={1}
        onPress={closeSheet}
      >
        <Animated.View
          style={[
            styles.backdrop,
            { opacity: backdropOpacity }
          ]}
        />
      </TouchableOpacity>

      {/* Slide-up sheet container */}
      <Animated.View
        style={[
          styles.sheet,
          {
            transform: [{ translateY }],
          },
        ]}
      >
        {/* Header drag-bar handle */}
        <View {...panResponder.panHandlers}>
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>

          {/* Header Title bar */}
          <View style={styles.header}>
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerSubtitle}>Substitutes for</Text>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {ingredient.name}
              </Text>
            </View>
            <TouchableOpacity onPress={closeSheet} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Content Area */}
        <ScrollView
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
        >
          {loading && (
            <View style={styles.skeletonContainer}>
              {[1, 2, 3].map((key) => (
                <Animated.View
                  key={key}
                  style={[
                    styles.skeletonCard,
                    { opacity: skeletonAlpha }
                  ]}
                />
              ))}
            </View>
          )}

          {error && (
            <View style={styles.errorContainer}>
              <Ionicons name="warning-outline" size={36} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={fetchSubstitutions}>
                <Text style={styles.retryBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}

          {!loading && !error && substitutions.length > 0 && (
            <View style={styles.substitutesList}>
              {substitutions.map((sub, idx) => (
                <View key={idx} style={[styles.subCard, Shadows.sm]}>
                  <View style={styles.subCardHeader}>
                    <View style={styles.subBadge}>
                      <Ionicons name="swap-horizontal-outline" size={14} color={colors.primary} />
                    </View>
                    <Text style={styles.subName}>{sub.name}</Text>
                  </View>
                  
                  <View style={styles.ratioRow}>
                    <Text style={styles.ratioLabel}>Ratio:</Text>
                    <Text style={styles.ratioValue}>{sub.adjustment}</Text>
                  </View>

                  <Text style={styles.reasonText}>{sub.reason}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.3)',
    },
    sheet: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: SHEET_HEIGHT,
      backgroundColor: colors.background,
      borderTopLeftRadius: Radius.xxl,
      borderTopRightRadius: Radius.xxl,
      ...Shadows.lg,
      zIndex: 1000,
    },
    handleWrap: {
      alignItems: 'center',
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitleContainer: {
      flex: 1,
      marginRight: Spacing.md,
    },
    headerSubtitle: {
      fontSize: FontSizes.xs,
      fontFamily: Fonts.medium,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    headerTitle: {
      fontSize: FontSizes.lg,
      fontFamily: Fonts.bold,
      color: colors.text,
      marginTop: 2,
    },
    closeBtn: {
      width: 28,
      height: 28,
      borderRadius: Radius.pill,
      backgroundColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    contentContainer: {
      paddingHorizontal: Spacing.xl,
      paddingTop: Spacing.md,
      paddingBottom: Spacing.massive,
    },
    skeletonContainer: {
      gap: Spacing.md,
    },
    skeletonCard: {
      height: 96,
      backgroundColor: colors.border,
      borderRadius: Radius.lg,
    },
    errorContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Spacing.xl,
      gap: Spacing.sm,
    },
    errorText: {
      fontSize: FontSizes.sm,
      fontFamily: Fonts.regular,
      color: colors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: Spacing.md,
      lineHeight: 20,
    },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.xs,
      backgroundColor: colors.primary,
      borderRadius: Radius.pill,
    },
    retryBtnText: {
      color: '#FFFFFF',
      fontSize: FontSizes.sm,
      fontFamily: Fonts.semibold,
    },
    substitutesList: {
      gap: Spacing.md,
    },
    subCard: {
      backgroundColor: colors.surface,
      borderRadius: Radius.lg,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      // Ensure child content never bleeds outside the card border
      overflow: 'hidden',
    },
    subCardHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Spacing.xs,
      marginBottom: Spacing.xs,
    },
    subBadge: {
      width: 24,
      height: 24,
      borderRadius: Radius.pill,
      backgroundColor: colors.primaryLight,
      alignItems: 'center',
      justifyContent: 'center',
      // Don't let the badge shrink so the icon stays crisp
      flexShrink: 0,
      marginTop: 1,
    },
    subName: {
      fontSize: FontSizes.md,
      fontFamily: Fonts.bold,
      color: colors.text,
      flex: 1,
      flexWrap: 'wrap',
    },
    ratioRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Spacing.xxs,
      marginBottom: Spacing.xs,
      flexWrap: 'wrap',
    },
    ratioLabel: {
      fontSize: FontSizes.xs,
      fontFamily: Fonts.medium,
      color: colors.textTertiary,
      flexShrink: 0,
    },
    ratioValue: {
      fontSize: FontSizes.xs,
      fontFamily: Fonts.semibold,
      color: colors.accent,
      flexShrink: 1,
      flexWrap: 'wrap',
    },
    reasonText: {
      fontSize: FontSizes.sm,
      fontFamily: Fonts.regular,
      color: colors.textSecondary,
      lineHeight: 18,
      flexWrap: 'wrap',
    },
  });
