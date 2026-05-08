// ============================================================
// Meal Wizard — Recipe Detail Bottom Drawer
// 90 % height bottom sheet with animated slide-in, swipe-to-
// dismiss via drag handle, and tap-backdrop-to-close.
// ============================================================

import { FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { updateMealPlanServings, updateRecipeCourse, updateRecipeTags } from '@/services/firestoreService';
import { applyServingScale, calculateRequiredServings } from '@/services/recipeScraperService';
import type { Ingredient, Recipe } from '@/services/types';
import { formatIngredientAmount } from '@/utils/ingredientFormat';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { WebView } from 'react-native-webview';
import YoutubePlayer from 'react-native-youtube-iframe';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.9;
const HERO_HEIGHT = 220;
const STEP_VIDEO_WIDTH = SCREEN_WIDTH - Spacing.xl * 2 - 28 /* badge */ - Spacing.md /* gap */;
const STEP_VIDEO_HEIGHT = Math.round((STEP_VIDEO_WIDTH * 9) / 16);

/**
 * Pull the YouTube video ID out of an embed URL, or null if it isn't YouTube.
 */
function youtubeIdFromEmbed(url: string): string | null {
  const m = url.match(/^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]+)/i);
  return m ? m[1] : null;
}

/**
 * VideoOrImage: renders an inline player for the URL, falling back to the
 * image (when supplied) on unrecoverable playback errors.
 *
 *  - YouTube URLs render via react-native-youtube-iframe, which exposes an
 *    onError callback for per-video restrictions (Error 152, etc.). On error
 *    we swap to the image. This is the case the user explicitly asked for —
 *    keep playback in-app, fall back to the static image when truly unplayable.
 *  - Direct video files (.mp4/.webm/.mov) render via a WebView with an HTML5
 *    <video controls> element.
 *  - Other iframe providers (Vimeo, Wistia) load directly via WebView source.uri.
 *
 * `width` is required for YoutubePlayer's aspect-ratio calc; `height` controls
 * the rendered box. `imageStyle` is applied to the fallback Image so callers
 * can match the same dimensions.
 */
function VideoOrImage({
  videoUrl,
  imageUrl,
  height,
  width,
  imageStyle,
}: {
  videoUrl: string;
  imageUrl?: string;
  height: number;
  width: number;
  imageStyle: any;
}) {
  const [errored, setErrored] = useState(false);
  const ytId = youtubeIdFromEmbed(videoUrl);

  if (errored && imageUrl) {
    return <Image source={{ uri: imageUrl }} style={imageStyle} resizeMode="cover" />;
  }

  if (ytId) {
    return (
      <YoutubePlayer
        videoId={ytId}
        height={height}
        width={width}
        play={false}
        onError={() => setErrored(true)}
      />
    );
  }

  // Vimeo / MP4 / other
  return (
    <WebView
      source={videoSourceForEmbed(videoUrl)}
      style={{ flex: 1, backgroundColor: '#000' }}
      allowsFullscreenVideo
      allowsInlineMediaPlayback
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
    />
  );
}

/**
 * Build a WebView source for a video embed URL. Three branches:
 *
 *  - **YouTube embeds** loaded as the WebView's top-level URI fail with
 *    "Error 153" on Android — the player JS expects an iframe-child context
 *    with sane Origin/Referer. We wrap it in a tiny HTML page loaded with
 *    baseUrl="https://www.youtube.com" so the WebView behaves as though
 *    the page came from youtube.com.
 *
 *  - **Direct video files** (Pinch of Yum's older Pinch-of-Yum-hosted MP4s
 *    arrive as Recipe.video.contentUrl). Wrap in a tiny HTML5 <video>
 *    element with controls.
 *
 *  - **Other iframe providers** (Vimeo, Wistia, etc.) load directly via
 *    source.uri. They don't have YouTube's restriction and Vimeo embeds
 *    are confirmed working.
 */
function videoSourceForEmbed(url: string): React.ComponentProps<typeof WebView>['source'] {
  const isYouTube = /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//i.test(url);
  const isVideoFile = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);

  if (isYouTube) {
    return {
      baseUrl: 'https://www.youtube.com',
      html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>html,body{margin:0;padding:0;background:#000;height:100%;width:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe src="${url}" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe></body></html>`,
    };
  }

  if (isVideoFile) {
    return {
      html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>html,body{margin:0;padding:0;background:#000;height:100%;width:100%;overflow:hidden}video{width:100%;height:100%;background:#000;display:block;object-fit:contain}</style></head><body><video controls playsinline preload="metadata"><source src="${url}"></video></body></html>`,
    };
  }

  return { uri: url };
}

type ThemeColors = ReturnType<typeof useTheme>['colors'];
type Styles = ReturnType<typeof makeStyles>;

interface Props {
  recipe: Recipe | null;
  visible: boolean;
  onClose: () => void;
  /** Called after a course update is persisted so the parent can refresh its recipe copy. */
  onCourseUpdate?: (recipeId: string, newCourse: string[]) => void;
  /** Called after a tag update is persisted so the parent can refresh its recipe copy. */
  onTagsUpdate?: (recipeId: string, newTags: string[]) => void;

  /** When set, the modal shows a Save Changes CTA and persists adults/children/servings here. */
  mealPlanEntry?: {
    id: string;
    adults?: number;
    children?: number;
    servings?: number;
  };

  /** Default servings to seed the stepper when no mealPlanEntry context. */
  defaultServings?: number;

  /** When set, the modal shows a star toggle in the header. */
  starred?: boolean;
  onStarToggle?: () => void;
}

export default function RecipeDetailModal({
  recipe,
  visible,
  onClose,
  onCourseUpdate,
  onTagsUpdate,
  mealPlanEntry,
  defaultServings,
  starred,
  onStarToggle,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { householdId } = useAuth();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ── Servings stepper state ──
  const defaultAdults =
    mealPlanEntry?.adults ?? mealPlanEntry?.servings ?? defaultServings ?? recipe?.originalServings ?? 2;
  const defaultChildren = mealPlanEntry?.children ?? 0;

  const [adults, setAdults] = useState(defaultAdults);
  const [children, setChildren] = useState(defaultChildren);
  const [savingServings, setSavingServings] = useState(false);

  useEffect(() => {
    setAdults(defaultAdults);
    setChildren(defaultChildren);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe?.id, mealPlanEntry?.id]);

  const currentServings = calculateRequiredServings(adults, children);
  const defaultServingsCalc = calculateRequiredServings(defaultAdults, defaultChildren);
  const dirtyServings = adults !== defaultAdults || children !== defaultChildren;

  const scaledRecipe = recipe
    ? applyServingScale(recipe, currentServings)
    : null;

  const clamp = (n: number) => Math.max(0, Math.min(12, n));

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
            {starred !== undefined && (
              <TouchableOpacity
                onPress={onStarToggle}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginRight: Spacing.xs, paddingTop: 4 }}
              >
                <Ionicons
                  name={starred ? 'star' : 'star-outline'}
                  size={22}
                  color={starred ? colors.warning : colors.textTertiary}
                />
              </TouchableOpacity>
            )}
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
          {/* Hero: video takes precedence over image when both exist (recipe-level
              overview clip from Schema.org Recipe.video). Fallback to imageUrl. */}
          {recipe.videoEmbedUrl ? (
            <View style={styles.heroVideo}>
              <VideoOrImage
                videoUrl={recipe.videoEmbedUrl}
                imageUrl={recipe.imageUrl}
                width={SCREEN_WIDTH}
                height={HERO_HEIGHT}
                imageStyle={styles.heroImage}
              />
            </View>
          ) : recipe.imageUrl ? (
            <Image
              source={{ uri: recipe.imageUrl }}
              style={styles.heroImage}
              resizeMode="cover"
            />
          ) : null}

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
            <MacroBadge value={String(recipe.nutrition.calories)} label="kcal" bg={colors.caloriesBadge} fg={colors.caloriesText} styles={styles} />
            <MacroBadge value={`${recipe.nutrition.protein}g`} label="protein" bg={colors.proteinBadge} fg={colors.proteinText} styles={styles} />
            <MacroBadge value={`${recipe.nutrition.carbs}g`} label="carbs" bg={colors.carbsBadge} fg={colors.carbsText} styles={styles} />
            <MacroBadge value={`${recipe.nutrition.fat}g`} label="fat" bg={colors.fatBadge} fg={colors.fatText} styles={styles} />
          </View>

          {/* Time chips */}
          <View style={styles.metaRow}>
            <MetaChip icon="time-outline" label="Prep" value={recipe.prepTime} styles={styles} colors={colors} />
            <MetaChip icon="flame-outline" label="Cook" value={recipe.cookTime} styles={styles} colors={colors} />
            <MetaChip icon="timer-outline" label="Total" value={recipe.totalTime ?? 'N/A'} styles={styles} colors={colors} />
          </View>

          {/* Servings stepper */}
          <View style={styles.stepperWrap}>
            <View style={styles.stepperRow}>
              <View style={styles.stepperCell}>
                <Text style={[styles.stepperLabel, { color: colors.textSecondary }]}>Adults</Text>
                <View style={styles.stepperControls}>
                  <TouchableOpacity
                    style={[styles.stepperBtn, { borderColor: colors.border }]}
                    onPress={() => setAdults((a) => clamp(a - 1))}
                  >
                    <Text style={[styles.stepperBtnText, { color: colors.text }]}>−</Text>
                  </TouchableOpacity>
                  <Text style={[styles.stepperCount, { color: colors.text }]}>{adults}</Text>
                  <TouchableOpacity
                    style={[styles.stepperBtn, { borderColor: colors.border }]}
                    onPress={() => setAdults((a) => clamp(a + 1))}
                  >
                    <Text style={[styles.stepperBtnText, { color: colors.text }]}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.stepperCell}>
                <Text style={[styles.stepperLabel, { color: colors.textSecondary }]}>Children</Text>
                <View style={styles.stepperControls}>
                  <TouchableOpacity
                    style={[styles.stepperBtn, { borderColor: colors.border }]}
                    onPress={() => setChildren((c) => clamp(c - 1))}
                  >
                    <Text style={[styles.stepperBtnText, { color: colors.text }]}>−</Text>
                  </TouchableOpacity>
                  <Text style={[styles.stepperCount, { color: colors.text }]}>{children}</Text>
                  <TouchableOpacity
                    style={[styles.stepperBtn, { borderColor: colors.border }]}
                    onPress={() => setChildren((c) => clamp(c + 1))}
                  >
                    <Text style={[styles.stepperBtnText, { color: colors.text }]}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.stepperReadoutRow}>
              <Text style={[styles.stepperReadout, { color: colors.textSecondary }]}>
                Servings: {currentServings}
                {dirtyServings ? `  (was ${defaultServingsCalc})` : ''}
              </Text>

              {dirtyServings && mealPlanEntry?.id && (
                <TouchableOpacity
                  style={[
                    styles.saveBtn,
                    { backgroundColor: colors.primary },
                    (savingServings || currentServings === 0) && { opacity: 0.5 },
                  ]}
                  disabled={savingServings || currentServings === 0}
                  onPress={async () => {
                    if (!householdId) return;
                    setSavingServings(true);
                    try {
                      await updateMealPlanServings(
                        householdId,
                        mealPlanEntry.id,
                        adults,
                        children,
                        currentServings
                      );
                    } catch (err) {
                      console.warn('[RecipeDetailModal] save servings failed:', err);
                    } finally {
                      setSavingServings(false);
                    }
                  }}
                >
                  <Text style={styles.saveBtnText}>
                    {savingServings ? 'Saving…' : 'Save Changes'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Ingredients */}
          <SectionLabel title="Ingredients" styles={styles} />
          {scaledRecipe?.ingredientGroups && scaledRecipe.ingredientGroups.length > 0 ? (
            scaledRecipe.ingredientGroups.map((group, gIdx) => (
              <View key={gIdx}>
                {group.name ? (
                  <Text style={styles.groupHeader}>{group.name}</Text>
                ) : null}
                <IngredientCard ingredients={group.ingredients} styles={styles} />
              </View>
            ))
          ) : (
            <IngredientCard ingredients={scaledRecipe?.ingredients ?? []} styles={styles} />
          )}

          {/* Instructions */}
          <SectionLabel title="Instructions" styles={styles} />
          {(() => {
            let stepNum = 0;
            return recipe.instructions.map((step, idx) => {
              if (step.isHeader) {
                return (
                  <Text key={idx} style={styles.stepHeader}>
                    {step.text}
                  </Text>
                );
              }
              stepNum += 1;
              return (
                <View key={idx} style={styles.stepRow}>
                  <View style={styles.stepBadge}>
                    <Text style={styles.stepNum}>{stepNum}</Text>
                  </View>
                  <View style={styles.stepBody}>
                    <Text style={styles.stepText}>{step.text}</Text>
                    {step.videoEmbedUrl ? (
                      <View style={styles.stepImage}>
                        <VideoOrImage
                          videoUrl={step.videoEmbedUrl}
                          imageUrl={step.imageUrl}
                          width={STEP_VIDEO_WIDTH}
                          height={STEP_VIDEO_HEIGHT}
                          imageStyle={styles.stepImage}
                        />
                      </View>
                    ) : step.imageUrl ? (
                      <Image source={{ uri: step.imageUrl }} style={styles.stepImage} />
                    ) : null}
                  </View>
                </View>
              );
            });
          })()}

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

function IngredientCard({ ingredients, styles }: { ingredients: Ingredient[]; styles: Styles }) {
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

function MacroBadge({ value, label, bg, fg, styles }: { value: string; label: string; bg: string; fg: string; styles: Styles }) {
  return (
    <View style={[styles.macroBadge, { backgroundColor: bg }]}>
      <Text style={[styles.macroValue, { color: fg }]}>{value}</Text>
      <Text style={[styles.macroLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

function MetaChip({ icon, label, value, styles, colors }: { icon: string; label: string; value: string; styles: Styles; colors: ThemeColors }) {
  return (
    <View style={styles.metaChip}>
      <Ionicons name={icon as any} size={14} color={colors.textSecondary} />
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function SectionLabel({ title, styles }: { title: string; styles: Styles }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

// ─── Styles ───────────────────────────────────────────────────

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
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
  heroVideo: {
    height: 220,
    marginHorizontal: -Spacing.xl,
    marginBottom: Spacing.lg,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  heroVideoInner: {
    flex: 1,
    backgroundColor: '#000',
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
  stepBody: { flex: 1, gap: Spacing.sm },
  stepText: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.regular,
    color: colors.text,
    lineHeight: 22,
  },
  stepImage: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: Radius.md,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  stepVideoInner: {
    flex: 1,
    backgroundColor: '#000',
  },
  stepHeader: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.bold,
    color: colors.text,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
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

  // Servings stepper
  stepperWrap: {
    marginTop: Spacing.lg,
    marginBottom: Spacing.md,
  },
  stepperRow: {
    flexDirection: 'row',
    gap: Spacing.lg,
  },
  stepperCell: {
    flex: 1,
    gap: Spacing.xs,
  },
  stepperLabel: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  stepperBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperBtnText: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.bold,
  },
  stepperCount: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.semibold,
    minWidth: 24,
    textAlign: 'center',
  },
  stepperReadoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.md,
  },
  stepperReadout: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
  },
  saveBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
  },
});
