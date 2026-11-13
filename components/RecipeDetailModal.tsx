// ============================================================
// Meal Wizard — Recipe Detail Bottom Drawer
// 90 % height bottom sheet with animated slide-in, swipe-to-
// dismiss via drag handle, and tap-backdrop-to-close.
// ============================================================

import { FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { catalogueMetadataClient } from '@/services/catalogueClient';
import { updateMealPlanServings } from '@/services/firestoreService';
import { legacyRecipeClient } from '@/services/legacyRecipeClient';
import { calculateRequiredServings } from '@/services/recipeScraperService';
import { formatRecipeNoteItems, formatRecipeNotes, hasMeaningfulNutrition, mergeRecipeLabels } from '@/services/recipePresentation';
import type { Ingredient, Recipe } from '@/services/types';
import { formatIngredientAmount } from '@/utils/ingredientFormat';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import YoutubePlayer from 'react-native-youtube-iframe';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import RecipeActionsDrawer from './connected/RecipeActionsDrawer';
import { IconButton } from './connected/classic';
import CookingDrawer from './connected/CookingDrawer';
import SubstitutionDrawer from './connected/SubstitutionDrawer';
import { useConnected } from '@/contexts/ConnectedContext';
import { ingredientOccurrences, type IngredientOccurrence } from '@/services/stepIngredients';
import type { Meal } from '@/services/connectedClient';
import { useBottomDrawerGesture } from '@/hooks/useBottomDrawerGesture';
import { useFavourite } from '@/hooks/useFavourite';
import FavouriteButton from './connected/FavouriteButton';

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
  actionBar?: React.ReactNode;
  initiallyCooking?: boolean;
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

}

export default function RecipeDetailModal({
  actionBar,
  initiallyCooking = false,
  recipe,
  visible,
  onClose,
  onCourseUpdate,
  onTagsUpdate,
  mealPlanEntry,
  defaultServings,
}: Props) {
  const favourite = useFavourite();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { householdId } = useAuth();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const connected = useConnected();
  const plannedMeal = connected.meals.find(m => m.id === mealPlanEntry?.id);
  const [cooking, setCooking] = useState(initiallyCooking);
  const [recipeActions, setRecipeActions] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => { AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion); const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion); return () => sub.remove(); }, []);
  const [sideRecipe, setSideRecipe] = useState<Recipe | null>(null);

  // ── Servings stepper state ──
  const defaultAdults =
    mealPlanEntry?.adults ?? mealPlanEntry?.servings ?? defaultServings ?? recipe?.originalServings ?? 2;
  const defaultChildren = mealPlanEntry?.children ?? 0;

  const [adults, setAdults] = useState(defaultAdults);
  const [children, setChildren] = useState(defaultChildren);
  const [savingServings, setSavingServings] = useState(false);
  const [savedAdults, setSavedAdults] = useState(defaultAdults);
  const [savedChildren, setSavedChildren] = useState(defaultChildren);
  const servingsRevision = useRef<number | undefined>(plannedMeal?.revision);
  const [nutritionExpanded, setNutritionExpanded] = useState(false);
  const [heroImageIndex, setHeroImageIndex] = useState(0);

  // Capture the occurrence and meal revision together when opening substitutions.
  const [substitution, setSubstitution] = useState<{ occurrence: IngredientOccurrence; meal?: Meal } | null>(null);

  useEffect(() => {
    setAdults(defaultAdults);
    setChildren(defaultChildren);
    setSavedAdults(defaultAdults);
    setSavedChildren(defaultChildren);
    servingsRevision.current = plannedMeal?.revision;
    setNutritionExpanded(false);
    setHeroImageIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe?.id, mealPlanEntry?.id]);

  const currentServings = calculateRequiredServings(adults, children);
  const defaultServingsCalc = calculateRequiredServings(savedAdults, savedChildren);
  const dirtyServings = adults !== savedAdults || children !== savedChildren;

  const cookingServings = currentServings + (recipe?.id === plannedMeal?.recipeId ? plannedMeal?.allocatedPortions ?? 0 : 0);
  const occurrences = recipe ? ingredientOccurrences(recipe, cookingServings, plannedMeal) : [];
  const handleIngredientLongPress = (index: number) => {
    const occurrence = occurrences[index];
    if (!occurrence) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setSubstitution({ occurrence, meal: plannedMeal });
  };

  const clamp = (n: number) => Math.max(0, Math.min(12, n));

  // ── Animation values ──────────────────────────────────────
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const closeSheet = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SHEET_HEIGHT,
        duration: reduceMotion ? 0 : 260,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: reduceMotion ? 0 : 200,
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  }, [onClose, translateY, backdropOpacity, reduceMotion]);


  // Animate in when becoming visible
  useEffect(() => {
    if (visible) {
      if (reduceMotion) { translateY.setValue(0); backdropOpacity.setValue(1); return; }
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
  }, [visible, translateY, backdropOpacity, reduceMotion]);

  const drag = useBottomDrawerGesture({ translateY, backdropOpacity, close: closeSheet });

  // ── Unified label editing state (course + tags combined) ────
  const [editingLabels, setEditingLabels] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);
  const [localCourse, setLocalCourse] = useState<string[]>([]);
  const [localTags, setLocalTags] = useState<string[]>([]);
  const nutrition = recipe?.nutrition;
  const nutritionAvailable = hasMeaningfulNutrition(nutrition);
  const heroImages = useMemo(() => [...new Set([
    ...(recipe?.imageUrl ? [recipe.imageUrl] : []),
    ...(recipe?.imageUrls ?? []),
  ])], [recipe?.imageUrl, recipe?.imageUrls]);
  const sourceClaims = useMemo(() => [...new Set([
    ...(recipe?.dietaryClaims ?? []),
    ...(recipe?.cookingMethods ?? []),
  ])], [recipe?.dietaryClaims, recipe?.cookingMethods]);
  const extraNutrition = nutrition ? [
    ['Fibre', nutrition.fiber, 'g'],
    ['Sugar', nutrition.sugar, 'g'],
    ['Saturated fat', nutrition.saturatedFat, 'g'],
    ['Unsaturated fat', nutrition.unsaturatedFat, 'g'],
    ['Trans fat', nutrition.transFat, 'g'],
    ['Sodium', nutrition.sodium, 'mg'],
    ['Cholesterol', nutrition.cholesterol, 'mg'],
  ].filter((entry): entry is [string, number, string] => (
    typeof entry[1] === 'number' && Number.isFinite(entry[1])
  )) : [];

  useEffect(() => {
    setLocalCourse(recipe?.course ?? []);
    setLocalTags(recipe?.tags ?? []);
    setEditingLabels(false);
  }, [recipe]);

  const handleSaveLabels = useCallback(async () => {
    if (!recipe?.id || (recipe.schemaVersion !== 2 && !householdId)) return;
    setSavingLabels(true);
    try {
      if (recipe.schemaVersion === 2) {
        await catalogueMetadataClient.updateLabels(recipe.id, localCourse, localTags);
      } else {
        if (!householdId) return;
        await legacyRecipeClient.update(householdId, recipe.id, {
          course: localCourse,
          tags: localTags,
        });
      }
      setEditingLabels(false);
      onCourseUpdate?.(recipe.id, localCourse);
      onTagsUpdate?.(recipe.id, localTags);
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('Choose ')
        ? error.message
        : 'Could not save changes.';
      Alert.alert('Error', message);
    } finally {
      setSavingLabels(false);
    }
  }, [householdId, recipe?.id, recipe?.schemaVersion, localCourse, localTags, onCourseUpdate, onTagsUpdate]);

  const handleCancelLabels = useCallback(() => {
    setLocalCourse(recipe?.course ?? []);
    setLocalTags(recipe?.tags ?? []);
    setEditingLabels(false);
  }, [recipe]);

  const COURSE_TAGS = ['Breakfast', 'Lunch', 'Dinner', 'Side', 'Snack'];
  const MODIFIER_TAGS = ['Healthy', 'Vegetarian', 'Kid Friendly', 'Salad'];
  const CUISINE_TAGS = [
    'Asian', 'Mexican', 'Mediterranean', 'Italian', 'Indian',
    'Greek', 'American', 'French', 'Middle Eastern', 'Global',
  ];

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
      <GestureHandlerRootView style={{ flex: 1 }}>
      {/* ── Dimmed backdrop — tap to close ── */}
      <TouchableOpacity
        style={StyleSheet.absoluteFill}
        activeOpacity={1}
        onPress={closeSheet}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
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
        <GestureDetector gesture={drag.headerGesture}>
        <View>
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
              {(recipe.attribution?.author || recipe.attribution?.publisher || recipe.sourceRating) ? (
                <Text style={styles.attributionText}>
                  {[
                    recipe.attribution?.author ? `By ${recipe.attribution.author}` : undefined,
                    recipe.attribution?.publisher,
                    recipe.sourceRating
                      ? `★ ${recipe.sourceRating.value.toFixed(1)}${recipe.sourceRating.count !== undefined ? ` (${recipe.sourceRating.count})` : ''}`
                      : undefined,
                  ].filter(Boolean).join(' · ')}
                </Text>
              ) : null}
            </View>
            <IconButton icon="ellipsis-horizontal" label="Recipe options" onPress={() => setRecipeActions(true)} />
            {recipe.id && (
              <FavouriteButton
                title={recipe.title}
                starred={favourite.starred(recipe.id)}
                pending={favourite.pending(recipe.id)}
                disabled={favourite.disabled}
                onPress={() => favourite.toggle(recipe.id!)}
              />
            )}
            <TouchableOpacity
              onPress={closeSheet}
              accessibilityRole="button"
              accessibilityLabel="Close recipe"
              style={styles.closeBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
        </GestureDetector>

        {/* ── Scrollable content ── */}
        <ScrollView
          {...drag.contentHandlers}
          onScroll={(event) => drag.setScrollOffset(event.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero: video takes precedence over image when both exist (recipe-level
              overview clip from Schema.org Recipe.video). Fallback to imageUrl. */}
          {recipe.videoEmbedUrl ? (
            <View style={styles.heroVideo}>
              <VideoOrImage
                videoUrl={recipe.videoEmbedUrl}
                imageUrl={heroImages[heroImageIndex]}
                width={SCREEN_WIDTH}
                height={HERO_HEIGHT}
                imageStyle={styles.heroImage}
              />
            </View>
          ) : heroImages[heroImageIndex] ? (
            <Image
              source={{ uri: heroImages[heroImageIndex] }}
              style={styles.heroImage}
              resizeMode="cover"
              onError={() => setHeroImageIndex((index) => Math.min(index + 1, heroImages.length))}
            />
          ) : null}

          {actionBar}

          {sourceClaims.length ? (
            <View style={styles.sourceClaimWrap}>
              <Text style={styles.sourceClaimLabel}>Source-declared</Text>
              <View style={styles.sourceClaimRow}>
                {sourceClaims.map((claim) => (
                  <View key={claim.toLowerCase()} style={styles.sourceClaimChip}>
                    <Text style={styles.sourceClaimText}>{claim}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {/* Labels (course + cuisine + modifier) — unified section */}
          <View style={styles.courseRow}>
            {!editingLabels && (
              <View style={styles.coursePills}>
                {mergeRecipeLabels(localCourse, localTags).map((label) => (
                  <View key={label.toLowerCase()} style={styles.coursePill}>
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
                  <TouchableOpacity
                    onPress={handleSaveLabels}
                    style={styles.courseEditBtn}
                    disabled={savingLabels}
                  >
                    <Text style={[styles.courseEditBtnText, { color: colors.primary }]}>
                      {savingLabels ? 'Saving…' : 'Save'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleCancelLabels} style={styles.courseEditBtn} disabled={savingLabels}>
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
                      if (active) {
                        // Remove from BOTH arrays — Gemini may have written a course-named
                        // value (e.g. "Dinner") into tags even when course holds something
                        // else like "Main Course". Without this the pill would survive.
                        setLocalCourse((prev) => prev.filter((c) => c.toLowerCase() !== tag.toLowerCase()));
                        setLocalTags((prev) => prev.filter((t) => t.toLowerCase() !== tag.toLowerCase()));
                      } else if (isCourseTag) {
                        setLocalCourse((prev) => [...prev, tag]);
                      } else {
                        setLocalTags((prev) => [...prev, tag]);
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
          {nutritionAvailable ? (
            <>
              <View style={[styles.macroStrip, extraNutrition.length ? { marginBottom: Spacing.sm } : null]}>
                <MacroBadge value={nutrition.calories === undefined ? '—' : String(nutrition.calories)} label="kcal" bg={colors.caloriesBadge} fg={colors.caloriesText} styles={styles} />
                <MacroBadge value={nutrition.protein === undefined ? '—' : `${nutrition.protein}g`} label="protein" bg={colors.proteinBadge} fg={colors.proteinText} styles={styles} />
                <MacroBadge value={nutrition.carbs === undefined ? '—' : `${nutrition.carbs}g`} label="carbs" bg={colors.carbsBadge} fg={colors.carbsText} styles={styles} />
                <MacroBadge value={nutrition.fat === undefined ? '—' : `${nutrition.fat}g`} label="fat" bg={colors.fatBadge} fg={colors.fatText} styles={styles} />
              </View>
              {extraNutrition.length ? (
                <View style={styles.nutritionPanel}>
                  <TouchableOpacity
                    style={styles.nutritionToggle}
                    onPress={() => setNutritionExpanded((expanded) => !expanded)}
                  >
                    <Text style={styles.nutritionToggleText}>Nutrition per serving</Text>
                    <Ionicons name={nutritionExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
                  </TouchableOpacity>
                  {nutritionExpanded ? extraNutrition.map(([label, value, unit]) => (
                    <View key={label} style={styles.nutritionRow}>
                      <Text style={styles.nutritionName}>{label}</Text>
                      <Text style={styles.nutritionValue}>{value}{unit}</Text>
                    </View>
                  )) : null}
                </View>
              ) : null}
            </>
          ) : (
            <Text style={[styles.nutritionUnavailable, { color: colors.textTertiary }]}>Nutrition unavailable</Text>
          )}

          {/* Time chips */}
          <View style={styles.metaRow}>
            <MetaChip icon="time-outline" label="Prep" value={recipe.prepTime} styles={styles} colors={colors} />
            <MetaChip icon="flame-outline" label="Cook" value={recipe.cookTime} styles={styles} colors={colors} />
            <MetaChip icon="timer-outline" label="Total" value={recipe.totalTime ?? 'N/A'} styles={styles} colors={colors} />
          </View>
          {recipe.additionalTimes?.length ? (
            <View style={styles.additionalTimes}>
              {recipe.additionalTimes.map((time) => (
                <Text key={`${time.label}-${time.minutes}`} style={styles.additionalTimeText}>
                  {time.label}: {time.minutes} min
                </Text>
              ))}
            </View>
          ) : null}

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
                  disabled={savingServings || currentServings === 0 || !connected.online}
                  onPress={async () => {
                    if (!householdId) return;
                    setSavingServings(true);
                    try {
                      if (plannedMeal) {
                        const isSide = recipe.id !== plannedMeal.recipeId;
                        if (isSide && !plannedMeal.sides?.some(side => side.recipeId === recipe.id)) throw new Error('This side is no longer attached to the meal.');
                        const revision = servingsRevision.current ?? plannedMeal.revision;
                        await connected.run({ operation: 'mutate', changes: [{ meal: isSide
                          ? { ...plannedMeal, sides: plannedMeal.sides?.map(side => side.recipeId === recipe.id ? { ...side, servings: currentServings } : side) }
                          : { ...plannedMeal, adults, children, servings: currentServings }, expectedRevision: revision }] });
                        servingsRevision.current = revision + 1;
                      } else {
                        await updateMealPlanServings(householdId, mealPlanEntry.id, adults, children, currentServings, (mealPlanEntry as typeof mealPlanEntry & { revision?: number }).revision);
                      }
                      setSavedAdults(adults); setSavedChildren(children);
                    } catch (err) {
                      Alert.alert('Could not save servings', err instanceof Error ? err.message : 'Please retry.');
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

          {recipe.equipment?.length ? (
            <>
              <SectionLabel title="Equipment" styles={styles} />
              <View style={styles.card}>
                {recipe.equipment.map((item, index) => (
                  <View key={`${item.name}-${index}`} style={[styles.equipmentRow, index < recipe.equipment!.length - 1 && styles.ingredientDivider]}>
                    <Ionicons name="restaurant-outline" size={16} color={colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.equipmentName}>{item.name}</Text>
                      {item.notes ? <Text style={styles.ingredientNotes}>{item.notes}</Text> : null}
                    </View>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {/* Ingredients */}
          <SectionLabel title="Ingredients" styles={styles} />
          {[...new Set(occurrences.map(o => o.groupIndex))].map(groupIndex => (
            <View key={groupIndex}>
              {!!occurrences.find(o => o.groupIndex === groupIndex)?.group && <Text style={styles.groupHeader}>{occurrences.find(o => o.groupIndex === groupIndex)!.group}</Text>}
              <IngredientCard ingredients={occurrences.filter(o => o.groupIndex === groupIndex).map(o => o.ingredient)} styles={styles}
                onIngredientLongPress={(_, index) => handleIngredientLongPress(occurrences.indexOf(occurrences.filter(o => o.groupIndex === groupIndex)[index]))} />
            </View>
          ))}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
            <Text style={[styles.sectionTitle, { flex: 1, marginTop: 0, marginBottom: 0 }]}>Instructions</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Start cooking" onPress={() => setCooking(true)} style={{ minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 22, backgroundColor: colors.primaryLight }}>
              <Ionicons name="play" size={16} color={colors.primary} /><Text style={{ fontFamily: Fonts.semibold, fontSize: 14, color: colors.primary }}>Start cooking</Text>
            </Pressable>
          </View>
          {!!plannedMeal?.sides?.length && recipe.id === plannedMeal.recipeId && <View style={{ gap: 8 }}>{plannedMeal.sides.map(side => <Pressable key={side.recipeId} accessibilityRole="button" accessibilityLabel={`Open side: ${connected.recipes[side.recipeId]?.title ?? 'Side'}`} onPress={() => connected.load(side.recipeId).then(r => setSideRecipe(r)).catch(e => Alert.alert('Could not open side', e.message))} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: colors.primary, fontFamily: Fonts.medium }}>+ {connected.recipes[side.recipeId]?.title ?? 'Side'}</Text></Pressable>)}</View>}
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
                    {step.title ? <Text style={styles.stepTitle}>{step.title}</Text> : null}
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
          {recipe.noteSections?.length ? (
            <View style={styles.notesBox}>
              <Text style={styles.notesTitle}>Notes</Text>
              {recipe.noteSections.map((section, index) => (
                <View key={`${section.title ?? 'notes'}-${index}`} style={styles.noteSection}>
                  {section.title ? <Text style={styles.noteSectionTitle}>{section.title}</Text> : null}
                  {formatRecipeNoteItems(section.items).map((item, itemIndex) => (
                    <Text key={itemIndex} style={styles.notesText}>{item}</Text>
                  ))}
                </View>
              ))}
            </View>
          ) : recipe.notes?.trim() ? (
            <View style={styles.notesBox}>
              <Text style={styles.notesTitle}>Notes</Text>
              {formatRecipeNotes(recipe.notes).map((item, index) => (
                <Text key={index} style={styles.notesText}>{item}</Text>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </Animated.View>

      {recipeActions && <RecipeActionsDrawer recipeId={recipe.id!} meal={recipe.id === plannedMeal?.recipeId ? plannedMeal : undefined} onClose={() => setRecipeActions(false)} />}
      {substitution && <SubstitutionDrawer occurrence={substitution.occurrence} recipe={recipe} meal={substitution.meal} servings={cookingServings} onClose={() => setSubstitution(null)} />}
      {cooking && <CookingDrawer recipe={recipe} meal={plannedMeal} servings={cookingServings} onClose={() => setCooking(false)} renderMedia={step => step.videoEmbedUrl ? <View style={styles.stepImage}><VideoOrImage videoUrl={step.videoEmbedUrl} imageUrl={step.imageUrl} width={STEP_VIDEO_WIDTH} height={STEP_VIDEO_HEIGHT} imageStyle={styles.stepImage} /></View> : step.imageUrl ? <Image source={{ uri: step.imageUrl }} style={styles.stepImage} /> : null} />}
      {sideRecipe && <RecipeDetailModal recipe={sideRecipe} visible onClose={() => setSideRecipe(null)} mealPlanEntry={mealPlanEntry ? { id: mealPlanEntry.id } : undefined} defaultServings={plannedMeal?.sides?.find(s => s.recipeId === sideRecipe.id)?.servings} />}
      </GestureHandlerRootView>
    </Modal>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function IngredientCard({
  ingredients,
  styles,
  onIngredientLongPress,
}: {
  ingredients: Ingredient[];
  styles: Styles;
  onIngredientLongPress?: (ing: Ingredient, index: number) => void;
}) {
  const { colors } = useTheme();

  return (
    <View style={[styles.card, Shadows.sm, { marginBottom: Spacing.sm }]}>
      {ingredients.map((ing, idx) => {
        const content = (
          <>
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
          </>
        );

        if (onIngredientLongPress) {
          return (
            <Pressable
              key={idx}
              accessibilityRole="button"
              accessibilityLabel={`Substitutions for ${ing.name}`}
              accessibilityHint="Long press for alternatives"
              onLongPress={() => onIngredientLongPress(ing, idx)}
              style={({ pressed }) => [
                styles.ingredientRow,
                { width: "100%", minHeight: 48 },
                pressed && { backgroundColor: `${colors.primary}14` } // Subtle primary tinted press highlight (~8%)
              ]}
              android_ripple={{ color: `${colors.primary}1F` }}
            >
              {content}
            </Pressable>
          );
        }

        return (
          <View
            key={idx}
            style={[
              styles.ingredientRow,
              { width: "100%", minHeight: 48 },
            ]}
          >
            {content}
          </View>
        );
      })}
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
  attributionText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: colors.textSecondary,
    marginTop: 3,
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
  description: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.regular,
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: Spacing.md,
  },
  sourceClaimWrap: { marginBottom: Spacing.md, gap: Spacing.xs },
  sourceClaimLabel: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sourceClaimRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  sourceClaimChip: {
    borderRadius: Radius.pill,
    backgroundColor: colors.accentLight,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  sourceClaimText: { fontSize: FontSizes.xs, fontFamily: Fonts.medium, color: colors.textSecondary },
  nutritionUnavailable: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
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
  nutritionPanel: {
    borderRadius: Radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.lg,
  },
  nutritionToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  nutritionToggleText: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold, color: colors.text },
  nutritionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingVertical: Spacing.xs,
  },
  nutritionName: { fontSize: FontSizes.sm, fontFamily: Fonts.regular, color: colors.textSecondary },
  nutritionValue: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold, color: colors.text },

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
  additionalTimes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: -Spacing.md,
    marginBottom: Spacing.lg,
  },
  additionalTimeText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.medium,
    color: colors.textSecondary,
  },

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
  equipmentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  equipmentName: { fontSize: FontSizes.md, fontFamily: Fonts.medium, color: colors.text },

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
  stepTitle: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.bold,
    color: colors.text,
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
  noteSection: { gap: 3, marginTop: Spacing.xs },
  noteSectionTitle: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    color: colors.text,
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
