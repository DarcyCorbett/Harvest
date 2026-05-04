// ============================================================
// Meal Wizard — Recipe Detail Bottom Drawer
// 90 % height bottom sheet with animated slide-in, swipe-to-
// dismiss via drag handle, and tap-backdrop-to-close.
// ============================================================

import { Colors, FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { updateRecipeCourse, updateRecipeTags } from '@/services/firestoreService';
import type { Ingredient, Recipe } from '@/services/types';
import { formatIngredientAmount } from '@/utils/ingredientFormat';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.9;

// Always light — matches the forced light-mode design
const colors = Colors.light;

interface Props {
  recipe: Recipe | null;
  visible: boolean;
  onClose: () => void;
  /** Called after a course update is persisted so the parent can refresh its recipe copy. */
  onCourseUpdate?: (recipeId: string, newCourse: string[]) => void;
  /** Called after a tag update is persisted so the parent can refresh its recipe copy. */
  onTagsUpdate?: (recipeId: string, newTags: string[]) => void;
}

export default function RecipeDetailModal({ recipe, visible, onClose, onCourseUpdate, onTagsUpdate }: Props) {
  const insets = useSafeAreaInsets();

  // ── Animation values ──────────────────────────────────────
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  // Keep a stable ref to the latest close handler so the PanResponder
  // (created once) can call it without stale closure issues.
  const closeSheetRef = useRef(() => { });

  const closeSheet = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SHEET_HEIGHT,
        duration: 260,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  }, [onClose, translateY, backdropOpacity]);

  useEffect(() => {
    closeSheetRef.current = closeSheet;
  }, [closeSheet]);

  // Animate in when becoming visible
  useEffect(() => {
    if (visible) {
      translateY.setValue(SHEET_HEIGHT);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          tension: 62,
          friction: 11,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  // ── Swipe-to-dismiss pan responder (handle area only) ─────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) {
          translateY.setValue(gs.dy);
          backdropOpacity.setValue(Math.max(0, 1 - gs.dy / (SHEET_HEIGHT * 0.6)));
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 110 || gs.vy > 0.6) {
          closeSheetRef.current();
        } else {
          Animated.parallel([
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
            Animated.timing(backdropOpacity, {
              toValue: 1,
              duration: 150,
              useNativeDriver: true,
            }),
          ]).start();
        }
      },
    })
  ).current;

  // ── Unified label editing state (course + tags combined) ────
  const [editingLabels, setEditingLabels] = useState(false);
  const [localCourse, setLocalCourse] = useState<string[]>([]);
  const [localTags, setLocalTags] = useState<string[]>([]);

  useEffect(() => {
    setLocalCourse(recipe?.course ?? []);
    setLocalTags(recipe?.tags ?? []);
    setEditingLabels(false);
  }, [recipe]);

  const handleSaveLabels = useCallback(async () => {
    if (!recipe?.id) return;
    try {
      await updateRecipeCourse(recipe.id, localCourse);
      await updateRecipeTags(recipe.id, localTags);
      setEditingLabels(false);
      onCourseUpdate?.(recipe.id, localCourse);
      onTagsUpdate?.(recipe.id, localTags);
    } catch {
      Alert.alert('Error', 'Could not save changes.');
    }
  }, [recipe?.id, localCourse, localTags, onCourseUpdate, onTagsUpdate]);

  const handleCancelLabels = useCallback(() => {
    setLocalCourse(recipe?.course ?? []);
    setLocalTags(recipe?.tags ?? []);
    setEditingLabels(false);
  }, [recipe]);

  const COURSE_TAGS = ['Breakfast', 'Lunch', 'Dinner', 'Side', 'Snack', 'Salad'];
  const MODIFIER_TAGS = ['Healthy', 'Vegetarian', 'Kid Friendly'];
  const CUISINE_TAGS = ['Asian', 'Mexican', 'Mediterranean', 'Italian', 'Indian'];

  if (!recipe) return null;

  const sourceDomain = recipe.sourceUrl
    ? recipe.sourceUrl.replace(/^https?:\/\//, '').split('/')[0]
    : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={closeSheet}
    >
      {/* ── Dimmed backdrop — tap to close ── */}
      <TouchableOpacity
        style={StyleSheet.absoluteFillObject}
        activeOpacity={1}
        onPress={closeSheet}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(0,0,0,0.45)', opacity: backdropOpacity },
          ]}
        />
      </TouchableOpacity>

      {/* ── Bottom sheet ── */}
      <Animated.View
        style={[
          styles.sheet,
          {
            height: SHEET_HEIGHT,
            paddingBottom: insets.bottom + Spacing.xl,
            transform: [{ translateY }],
          },
        ]}
      >
        {/* Drag handle — only this area captures the pan gesture */}
        <View {...panResponder.panHandlers}>
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>

          {/* Top bar */}
          <View style={styles.topBar}>
            <View style={{ flex: 1 }}>
              <Text style={styles.topBarTitle} numberOfLines={2}>
                {recipe.title}
              </Text>
              {sourceDomain && (
                <TouchableOpacity
                  style={styles.sourceRow}
                  onPress={() => Linking.openURL(recipe.sourceUrl).catch(() => { })}
                  activeOpacity={0.7}
                >
                  <Ionicons name="open-outline" size={12} color={colors.accent} />
                  <Text style={styles.sourceText}>{sourceDomain}</Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              onPress={closeSheet}
              style={styles.closeBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Scrollable content ── */}
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero image */}
          {recipe.imageUrl && (
            <Image
              source={{ uri: recipe.imageUrl }}
              style={styles.heroImage}
              resizeMode="cover"
            />
          )}

          {/* Labels (course + cuisine + modifier) — unified section */}
          <View style={styles.courseRow}>
            {!editingLabels && (
              <View style={styles.coursePills}>
                {[...localCourse, ...localTags].map((label, i) => (
                  <View key={i} style={styles.coursePill}>
                    <Text style={styles.coursePillText}>
                      {label.replace(/\b\w/g, (ch) => ch.toUpperCase())}
                    </Text>
                  </View>
                ))}
                {localCourse.length === 0 && localTags.length === 0 && (
                  <Text style={[styles.coursePillText, { color: colors.textTertiary, paddingHorizontal: 0 }]}>
                    No tags
                  </Text>
                )}
              </View>
            )}
            {recipe.id ? (
              editingLabels ? (
                <View style={styles.courseEditActions}>
                  <TouchableOpacity onPress={handleSaveLabels} style={styles.courseEditBtn}>
                    <Text style={[styles.courseEditBtnText, { color: colors.primary }]}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleCancelLabels} style={styles.courseEditBtn}>
                    <Text style={[styles.courseEditBtnText, { color: colors.textSecondary }]}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => setEditingLabels(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="pencil-outline" size={15} color={colors.textTertiary} />
                </TouchableOpacity>
              )
            ) : null}
          </View>
          {editingLabels && (
            <View style={styles.courseTagPicker}>
              {[...COURSE_TAGS, ...CUISINE_TAGS, ...MODIFIER_TAGS].map((tag) => {
                // Check both course and tags arrays
                const inCourse = localCourse.some((c) => c.toLowerCase() === tag.toLowerCase());
                const inTags = localTags.some((t) => t.toLowerCase() === tag.toLowerCase());
                const active = inCourse || inTags;
                const isCourseTag = COURSE_TAGS.includes(tag);
                return (
                  <TouchableOpacity
                    key={tag}
                    style={[styles.courseTagChip, active && styles.courseTagChipActive]}
                    onPress={() => {
                      if (isCourseTag) {
                        setLocalCourse((prev) =>
                          active
                            ? prev.filter((c) => c.toLowerCase() !== tag.toLowerCase())
                            : [...prev, tag]
                        );
                      } else {
                        setLocalTags((prev) =>
                          active
                            ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
                            : [...prev, tag]
                        );
                      }
                    }}
                  >
                    <Text style={[styles.courseTagChipText, active && styles.courseTagChipTextActive]}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Macro strip */}
          <View style={styles.macroStrip}>
            <MacroBadge value={String(recipe.nutrition.calories)} label="kcal" bg={colors.caloriesBadge} fg={colors.caloriesText} />
            <MacroBadge value={`${recipe.nutrition.protein}g`} label="protein" bg={colors.proteinBadge} fg={colors.proteinText} />
            <MacroBadge value={`${recipe.nutrition.carbs}g`} label="carbs" bg={colors.carbsBadge} fg={colors.carbsText} />
            <MacroBadge value={`${recipe.nutrition.fat}g`} label="fat" bg={colors.fatBadge} fg={colors.fatText} />
          </View>

          {/* Time chips */}
          <View style={styles.metaRow}>
            <MetaChip icon="time-outline" label="Prep" value={recipe.prepTime} />
            <MetaChip icon="flame-outline" label="Cook" value={recipe.cookTime} />
            <MetaChip icon="timer-outline" label="Total" value={recipe.totalTime ?? 'N/A'} />
          </View>

          {/* Ingredients */}
          <SectionLabel title="Ingredients" />
          {recipe.ingredientGroups && recipe.ingredientGroups.length > 0 ? (
            recipe.ingredientGroups.map((group, gIdx) => (
              <View key={gIdx}>
                {group.name ? (
                  <Text style={styles.groupHeader}>{group.name}</Text>
                ) : null}
                <IngredientCard ingredients={group.ingredients} />
              </View>
            ))
          ) : (
            <IngredientCard ingredients={recipe.ingredients} />
          )}

          {/* Instructions */}
          <SectionLabel title="Instructions" />
          {recipe.instructions.map((step, idx) => (
            <View key={idx} style={styles.stepRow}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepNum}>{idx + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}

          {/* Notes */}
          {recipe.notes?.trim() ? (
            <View style={styles.notesBox}>
              <Text style={styles.notesTitle}>Notes</Text>
              <Text style={styles.notesText}>{recipe.notes}</Text>
            </View>
          ) : null}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function IngredientCard({ ingredients }: { ingredients: Ingredient[] }) {
  return (
    <View style={[styles.card, Shadows.sm, { marginBottom: Spacing.sm }]}>
      {ingredients.map((ing, idx) => (
        <View
          key={idx}
          style={[
            styles.ingredientRow,
            idx < ingredients.length - 1 && styles.ingredientDivider,
          ]}
        >
          <View style={styles.dot} />
          <View style={styles.ingredientContent}>
            <Text style={styles.ingredientText}>
              {formatIngredientAmount(ing.quantity, ing.unit)
                ? `${formatIngredientAmount(ing.quantity, ing.unit)}  `
                : ''}
              <Text style={{ fontFamily: Fonts.semibold }}>{ing.name}</Text>
            </Text>
            {ing.notes ? (
              <Text style={styles.ingredientNotes}>{ing.notes}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function MacroBadge({ value, label, bg, fg }: { value: string; label: string; bg: string; fg: string }) {
  return (
    <View style={[styles.macroBadge, { backgroundColor: bg }]}>
      <Text style={[styles.macroValue, { color: fg }]}>{value}</Text>
      <Text style={[styles.macroLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

function MetaChip({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.metaChip}>
      <Ionicons name={icon as any} size={14} color={colors.textSecondary} />
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function SectionLabel({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

// ─── Styles ───────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Sheet
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    ...Shadows.lg,
  },

  handleWrap: {
    alignItems: 'center',
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },
  topBarTitle: {
    fontSize: FontSizes.xl,
    fontFamily: Fonts.bold,
    color: colors.text,
    lineHeight: 26,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xxs,
  },
  sourceText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.medium,
    color: colors.accent,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    backgroundColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
  },

  // Scroll
  scroll: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.massive,
  },

  heroImage: {
    height: 220,
    marginHorizontal: -Spacing.xl,
    marginBottom: Spacing.lg,
  },

  // Course pills
  courseRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  coursePills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
    flex: 1,
    marginBottom: Spacing.xs,
  },
  courseEditActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginLeft: Spacing.sm,
  },
  courseEditBtn: {
    paddingVertical: 2,
  },
  courseEditBtnText: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
  },
  courseTagPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
    marginBottom: Spacing.md,
    paddingTop: Spacing.xs,
  },
  courseTagChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  courseTagChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  courseTagChipText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.medium,
    color: colors.textSecondary,
  },
  courseTagChipTextActive: {
    color: colors.primary,
  },
  coursePill: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  coursePillText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.medium,
    color: colors.textSecondary,
  },

  // Macro strip
  macroStrip: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  macroBadge: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: Radius.xl,
    gap: 2,
  },
  macroValue: { fontSize: FontSizes.md, fontFamily: Fonts.bold },
  macroLabel: { fontSize: FontSizes.xs, fontFamily: Fonts.regular },

  // Meta chips
  metaRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  metaChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: colors.surface,
    gap: 2,
  },
  metaLabel: { fontSize: FontSizes.xs, fontFamily: Fonts.regular, color: colors.textSecondary },
  metaValue: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold, color: colors.text },

  // Section label
  sectionTitle: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.bold,
    color: colors.text,
    marginBottom: Spacing.md,
    marginTop: Spacing.xl,
  },

  // Ingredient group header
  groupHeader: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
    paddingHorizontal: Spacing.xs,
  },

  // Ingredient card
  card: {
    borderRadius: Radius.xl,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  ingredientRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  ingredientDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
    flexShrink: 0,
    marginTop: 7,
  },
  ingredientContent: { flex: 1 },
  ingredientText: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.regular,
    color: colors.text,
    lineHeight: 20,
  },
  ingredientNotes: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: colors.textTertiary,
    marginTop: 2,
    lineHeight: 16,
  },

  // Steps
  stepRow: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  stepNum: { fontSize: FontSizes.sm, fontFamily: Fonts.bold, color: colors.primary },
  stepText: {
    flex: 1,
    fontSize: FontSizes.lg,
    fontFamily: Fonts.regular,
    color: colors.text,
    lineHeight: 22,
  },

  // Notes
  notesBox: {
    borderRadius: Radius.md,
    padding: Spacing.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    backgroundColor: colors.surface,
    marginTop: Spacing.xl,
  },
  notesTitle: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.semibold,
    color: colors.text,
    marginBottom: Spacing.xs,
  },
  notesText: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.regular,
    color: colors.textSecondary,
    lineHeight: 22,
  },


});
