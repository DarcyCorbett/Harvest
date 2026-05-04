// ============================================================
// Meal Wizard — Generate Tab (Phase 4)
// Full meal plan generator: form → AI generation → review → save.
// ============================================================

import AnimatedPressable from '@/components/AnimatedPressable';
import PastelCard from '@/components/PastelCard';
import RecipeDetailModal from '@/components/RecipeDetailModal';
import SettingsModal from '@/components/SettingsModal';
import { Colors, FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { countUnpurchasedShoppingItems, getHouseholdSettings } from '@/services/firestoreService';
import {
  addDays,
  confirmMealPlan,
  findMismatchedMeals,
  formatDateDisplay,
  formatDateISO,
  generateMealPlan,
  getNextMonday,
  regenerateMeals,
  type GenerateConfig,
  type GeneratedMeal,
} from '@/services/generatorService';
import type { CuisineStyle, HouseholdSettings, MealType, Recipe } from '@/services/types';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// 2-column cuisine card: fills the horizontal padding with one gap in the middle
const { width: SCREEN_W } = Dimensions.get('window');
const CUISINE_CARD_W = (SCREEN_W - Spacing.xl * 2 - Spacing.md * 2) / 3;

// ─── Constants ────────────────────────────────────────────────

// Decorative pastel badges (intentionally light-only; they're soft tints used
// behind emojis and look fine over either theme background).
const BADGE = Colors.light;

const MAT_OPTIONS = [
  { id: 'Chicken', emoji: '🍗', bg: BADGE.caloriesBadge },
  { id: 'Meat', emoji: '🥩', bg: BADGE.proteinBadge },
  { id: 'Fish', emoji: '🐟', bg: BADGE.carbsBadge },
  { id: 'Egg', emoji: '🥚', bg: BADGE.fatBadge },
  { id: 'Broccoli', emoji: '🥦', bg: BADGE.proteinBadge },
  { id: 'Tomato', emoji: '🍅', bg: BADGE.caloriesBadge },
  { id: 'Pasta', emoji: '🍝', bg: BADGE.caloriesBadge },
  { id: 'Rice', emoji: '🍚', bg: BADGE.carbsBadge },
  { id: 'Potato', emoji: '🥔', bg: BADGE.fatBadge },
  { id: 'Carrot', emoji: '🥕', bg: BADGE.caloriesBadge },
  { id: 'Cheese', emoji: '🧀', bg: BADGE.caloriesBadge },
  { id: 'Lettuce', emoji: '🥬', bg: BADGE.proteinBadge },
];

const DAYS_OPTIONS = [1, 2, 3, 4, 5, 6, 7];

type EffortValue = 'Quick & Easy' | 'Moderate' | 'No Restriction';

const EFFORT_OPTIONS: { value: EffortValue; label: string; emoji: string }[] = [
  { value: 'Quick & Easy', label: 'Quick & Easy', emoji: '⚡' },
  { value: 'Moderate', label: 'Moderate', emoji: '🍳' },
  { value: 'No Restriction', label: 'Any', emoji: '🕐' },
];

const MODIFIER_OPTIONS: { style: CuisineStyle; emoji: string; bg: string }[] = [
  { style: 'Healthy', emoji: '🥑', bg: BADGE.proteinBadge },
  { style: 'Vegetarian', emoji: '🥗', bg: BADGE.proteinBadge },
  { style: 'Kid Friendly', emoji: '👧', bg: BADGE.fatBadge },
];

const CUISINE_OPTION_LIST: { style: CuisineStyle; emoji: string; bg: string }[] = [
  { style: 'Asian', emoji: '🍜', bg: BADGE.carbsBadge },
  { style: 'Mexican', emoji: '🌮', bg: BADGE.caloriesBadge },
  { style: 'Mediterranean', emoji: '🫒', bg: BADGE.proteinBadge },
  { style: 'Italian', emoji: '🍝', bg: BADGE.caloriesBadge },
  { style: 'Indian', emoji: '🍛', bg: BADGE.fatBadge },
  { style: 'Salad', emoji: '🥬', bg: BADGE.carbsBadge },
];

const MEAL_TYPE_OPTIONS: { type: MealType; label: string; icon: string }[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunny-outline' },
  { type: 'lunch', label: 'Lunch', icon: 'partly-sunny-outline' },
  { type: 'dinner', label: 'Dinner', icon: 'moon-outline' },
  { type: 'side', label: 'Side', icon: 'restaurant-outline' },
];

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  side: 'Side',
};

// ─── Main Screen ──────────────────────────────────────────────

type Phase = 'configure' | 'generating' | 'results' | 'saving';

export default function GenerateScreen() {
  const { householdId } = useAuth();
  const { colors } = useTheme();

  // ── Settings state ──
  const [settings, setSettings] = useState<HouseholdSettings>({ sourceWeights: {}, ingredientWeights: {} });
  const [settingsVisible, setSettingsVisible] = useState(false);

  useEffect(() => {
    if (!householdId) return;
    getHouseholdSettings(householdId).then(setSettings).catch(() => { });
  }, [householdId]);

  // ── Form state ──
  const [days, setDays] = useState(5);
  const [startDate, setStartDate] = useState<Date>(getNextMonday);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(2);
  const [mealTypes, setMealTypes] = useState<MealType[]>(['dinner']);
  const [effort, setEffort] = useState<EffortValue>('Moderate');
  const [modifiers, setModifiers] = useState<Set<CuisineStyle>>(new Set());
  const [selectedCuisines, setSelectedCuisines] = useState<Set<CuisineStyle>>(new Set());
  const cuisines = useMemo<CuisineStyle[]>(() => [
    ...(effort !== 'No Restriction' ? [effort as CuisineStyle] : []),
    ...modifiers,
    ...selectedCuisines,
  ], [effort, modifiers, selectedCuisines]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(new Set());

  // ── Flow state ──
  const [phase, setPhase] = useState<Phase>('configure');
  const [loadingMsg, setLoadingMsg] = useState('');
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [generatedMeals, setGeneratedMeals] = useState<GeneratedMeal[]>([]);
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(new Set());
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);

  // Snapshot of the selections used at the last successful Generate / Regenerate.
  // Regenerate and Auto-fix use this snapshot when the user has not actively
  // toggled anything on the results screen, so an unintentional press of those
  // buttons preserves the original intent rather than picking up shared state
  // changes from a back-trip to Configure.
  const [generateSnapshot, setGenerateSnapshot] = useState<{
    cuisines: CuisineStyle[];
    selectedMaterials: Set<string>;
  } | null>(null);
  const [resultsScreenDirty, setResultsScreenDirty] = useState(false);

  // ── Helpers ──
  const toggleMealType = (t: MealType) =>
    setMealTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );

  const handleEffortPress = (v: EffortValue) =>
    setEffort((prev) => (prev === v && v !== 'No Restriction' ? 'No Restriction' : v));

  const toggleModifier = (s: CuisineStyle) =>
    setModifiers((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const toggleCuisineSelection = (s: CuisineStyle) =>
    setSelectedCuisines((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  // Wrappers for the results-screen toggles — they delegate to the same
  // setters but mark the results screen as dirtied, so Regenerate / Auto-fix
  // know to use the current selections instead of the Generate-time snapshot.
  const onResultsEffortChange = (v: EffortValue) => {
    setResultsScreenDirty(true);
    handleEffortPress(v);
  };
  const onResultsToggleModifier = (s: CuisineStyle) => {
    setResultsScreenDirty(true);
    toggleModifier(s);
  };
  const onResultsToggleCuisineSelection = (s: CuisineStyle) => {
    setResultsScreenDirty(true);
    toggleCuisineSelection(s);
  };
  const onResultsToggleMaterial = (id: string) => {
    setResultsScreenDirty(true);
    setSelectedMaterials((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleChecked = (i: number) =>
    setCheckedIndices((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const resolveConfig = (): GenerateConfig | null => {
    if (mealTypes.length === 0) {
      Alert.alert('No meal types selected', 'Please select at least one meal type.');
      return null;
    }

    // Wire selected ingredient tiles to the forceSeed round-robin mechanism
    const seeds = Array.from(selectedMaterials).map((m) => m.toLowerCase());
    const configSettings = seeds.length > 0 ? { ...settings, selectedSeeds: seeds } : settings;
    return {
      startDate,
      numberOfDays: days,
      adults,
      children,
      mealTypes,
      cuisineStyles: cuisines,
      customInstructions: customInstructions.trim() || undefined,
      settings: configSettings,
    };
  };

  // ── Generation ──
  const handleGenerate = useCallback(async () => {
    if (!householdId) return;
    const config = resolveConfig();
    if (!config) return;

    setPhase('generating');
    setLoadingMsg('Searching for the perfect recipes…');
    setLoadingProgress({ current: 0, total: config.numberOfDays * config.mealTypes.length });

    try {
      const meals = await generateMealPlan(config, householdId, (msg, current, total) => {
        setLoadingMsg(msg);
        setLoadingProgress({ current, total });
      });
      setGeneratedMeals(meals);
      setCheckedIndices(new Set(meals.map((_, i) => i)));
      setGenerateSnapshot({ cuisines, selectedMaterials: new Set(selectedMaterials) });
      setResultsScreenDirty(false);
      setPhase('results');
    } catch (err) {
      setPhase('configure');
      Alert.alert(
        'Generation failed',
        err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      );
    }
  }, [householdId, days, startDate, adults, children, mealTypes, cuisines, customInstructions, selectedMaterials]);

  // ── Regenerate selected ──
  const handleRegenerate = useCallback(async () => {
    if (!householdId) return;
    const indices = Array.from(checkedIndices);
    if (indices.length === 0) return;

    const activeCuisines = resultsScreenDirty ? cuisines : (generateSnapshot?.cuisines ?? cuisines);
    const activeMaterials = resultsScreenDirty
      ? selectedMaterials
      : (generateSnapshot?.selectedMaterials ?? selectedMaterials);
    const seeds = Array.from(activeMaterials).map((m) => m.toLowerCase());
    const activeSettings = seeds.length > 0 ? { ...settings, selectedSeeds: seeds } : settings;

    setPhase('generating');
    setLoadingMsg('Regenerating selected recipes…');
    setLoadingProgress({ current: 0, total: indices.length });

    try {
      const updated = await regenerateMeals(
        generatedMeals,
        indices,
        {
          cuisineStyles: activeCuisines,
          customInstructions: customInstructions.trim() || undefined,
          adults,
          children,
          settings: activeSettings,
        },
        (msg, current, total) => {
          setLoadingMsg(msg);
          setLoadingProgress({ current, total });
        }
      );
      setGeneratedMeals(updated);
      setCheckedIndices(new Set());
      setGenerateSnapshot({ cuisines: activeCuisines, selectedMaterials: new Set(activeMaterials) });
      setResultsScreenDirty(false);
      setPhase('results');
    } catch (err) {
      setPhase('results');
      Alert.alert('Regeneration failed', err instanceof Error ? err.message : 'Please try again.');
    }
  }, [householdId, checkedIndices, generatedMeals, cuisines, customInstructions, adults, children, selectedMaterials, settings, resultsScreenDirty, generateSnapshot]);

  // ── Regenerate mismatched ──
  const handleRegenerateMismatched = useCallback(async () => {
    if (!householdId) return;

    const activeCuisines = resultsScreenDirty ? cuisines : (generateSnapshot?.cuisines ?? cuisines);
    const activeMaterials = resultsScreenDirty
      ? selectedMaterials
      : (generateSnapshot?.selectedMaterials ?? selectedMaterials);

    const mismatches = findMismatchedMeals(generatedMeals, activeCuisines);
    const mismatchedIndices = mismatches.map((m) => m.index);

    if (mismatchedIndices.length === 0) {
      Alert.alert('No Mismatches', 'All recipes match the selected criteria.');
      return;
    }

    mismatches.forEach((m) => {
      console.log(`[AutoFix] Slot ${m.index} (${generatedMeals[m.index].mealType} — "${generatedMeals[m.index].recipe.title}"): ${m.reasons.join('; ')}`);
    });

    setPhase('generating');
    setLoadingMsg(`Regenerating ${mismatchedIndices.length} mismatched recipe${mismatchedIndices.length !== 1 ? 's' : ''}…`);
    setLoadingProgress({ current: 0, total: mismatchedIndices.length });

    try {
      const seeds = Array.from(activeMaterials).map((m) => m.toLowerCase());
      const updated = await regenerateMeals(
        generatedMeals,
        mismatchedIndices,
        {
          cuisineStyles: activeCuisines,
          customInstructions: customInstructions.trim() || undefined,
          adults,
          children,
          settings: seeds.length > 0 ? { ...settings, selectedSeeds: seeds } : settings,
        },
        (msg, current, total) => {
          setLoadingMsg(msg);
          setLoadingProgress({ current, total });
        }
      );
      setGeneratedMeals(updated);
      setCheckedIndices(new Set());
      setGenerateSnapshot({ cuisines: activeCuisines, selectedMaterials: new Set(activeMaterials) });
      setResultsScreenDirty(false);
      setPhase('results');
    } catch (err) {
      setPhase('results');
      Alert.alert('Regeneration failed', err instanceof Error ? err.message : 'Please try again.');
    }
  }, [householdId, generatedMeals, cuisines, customInstructions, adults, children, selectedMaterials, settings, resultsScreenDirty, generateSnapshot]);

  // ── Add to calendar ──
  const performConfirm = useCallback(
    async (mode: 'add' | 'replace') => {
      if (!householdId) return;
      setLoadingMsg('Adding to calendar…');
      setLoadingProgress({ current: 0, total: 0 });
      setPhase('saving');
      try {
        await confirmMealPlan(generatedMeals, householdId, mode);
        setPhase('configure');
        setGeneratedMeals([]);
        setCheckedIndices(new Set());
        Alert.alert('Done!', 'Your meal plan has been added to the calendar and shopping list.');
      } catch (err) {
        setPhase('results');
        Alert.alert('Save failed', err instanceof Error ? err.message : 'Please try again.');
      }
    },
    [householdId, generatedMeals]
  );

  const handleAddToCalendar = useCallback(async () => {
    if (!householdId) return;
    let unpurchased = 0;
    try {
      unpurchased = await countUnpurchasedShoppingItems(householdId);
    } catch (err) {
      console.warn('[Generate] Failed to check existing shopping list:', err);
    }
    if (unpurchased > 0) {
      Alert.alert(
        'Existing shopping list',
        `You have ${unpurchased} unpurchased item${unpurchased === 1 ? '' : 's'} on your shopping list. Add the new ingredients to the existing list, or replace it?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace', style: 'destructive', onPress: () => performConfirm('replace') },
          { text: 'Add to list', onPress: () => performConfirm('add') },
        ]
      );
      return;
    }
    performConfirm('add');
  }, [householdId, performConfirm]);

  // ─── Render ───────────────────────────────────────────────

  if (phase === 'generating' || phase === 'saving') {
    return <LoadingScreen colors={colors} message={loadingMsg} progress={loadingProgress} />;
  }

  if (phase === 'results') {
    return (
      <>
        <ResultsScreen
          colors={colors}
          meals={generatedMeals}
          checkedIndices={checkedIndices}
          onToggleCheck={toggleChecked}
          onPreview={(r) => setPreviewRecipe(r)}
          onRegenerate={handleRegenerate}
          onRegenerateMismatched={handleRegenerateMismatched}
          onAddToCalendar={handleAddToCalendar}
          onBack={() => setPhase('configure')}
          effort={effort}
          onEffortChange={onResultsEffortChange}
          modifiers={modifiers}
          onToggleModifier={onResultsToggleModifier}
          selectedCuisines={selectedCuisines}
          onToggleCuisineSelection={onResultsToggleCuisineSelection}
          selectedMaterials={selectedMaterials}
          onToggleMaterial={onResultsToggleMaterial}
        />
        <RecipeDetailModal
          recipe={previewRecipe}
          visible={!!previewRecipe}
          onClose={() => setPreviewRecipe(null)}
          onCourseUpdate={(id, course) => {
            setPreviewRecipe((prev) => prev?.id === id ? { ...prev, course } : prev);
            setGeneratedMeals((prev) =>
              prev.map((m) => m.recipe.id === id ? { ...m, recipe: { ...m.recipe, course } } : m)
            );
          }}
          onTagsUpdate={(id, tags) => {
            setPreviewRecipe((prev) => prev?.id === id ? { ...prev, tags } : prev);
            setGeneratedMeals((prev) =>
              prev.map((m) => m.recipe.id === id ? { ...m, recipe: { ...m.recipe, tags } } : m)
            );
          }}
        />
      </>
    );
  }

  // ── Configure phase ───────────────────────────────────────
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: 120 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.gearBtn}
            onPress={() => setSettingsVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={[styles.topLabel, { color: colors.textSecondary }]}>Let's Start…</Text>
          <Text style={[styles.title, { color: colors.text }]}>What style of{'\n'}meal do you want?</Text>
        </View>

        {/* ── Section: Effort ── */}
        <View style={styles.materialsWrapper}>
          <Text style={[styles.styleGroupLabel, { color: colors.textSecondary }]}>EFFORT</Text>
          <View style={styles.effortRow}>
            {EFFORT_OPTIONS.map(({ value, label, emoji }) => {
              const active = effort === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[styles.effortBtn, { backgroundColor: colors.surface }, active && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => handleEffortPress(value)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.effortEmoji}>{emoji}</Text>
                  <Text style={[styles.effortLabel, { color: active ? '#fff' : colors.text }]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* ── Section: Modifiers ── */}
          <Text style={[styles.styleGroupLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>MODIFIERS</Text>
          <View style={styles.materialsGrid}>
            {MODIFIER_OPTIONS.map(({ style, emoji, bg }) => (
              <PastelCard
                key={style}
                title={style}
                emoji={emoji}
                selectedColorHex={bg}
                selected={modifiers.has(style)}
                onPress={() => toggleModifier(style)}
                cardWidth={CUISINE_CARD_W}
              />
            ))}
          </View>

          {/* ── Section: Cuisines ── */}
          <Text style={[styles.styleGroupLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>CUISINES</Text>
          <View style={styles.materialsGrid}>
            {CUISINE_OPTION_LIST.map(({ style, emoji, bg }) => (
              <PastelCard
                key={style}
                title={style}
                emoji={emoji}
                selectedColorHex={bg}
                selected={selectedCuisines.has(style)}
                onPress={() => toggleCuisineSelection(style)}
                cardWidth={CUISINE_CARD_W}
              />
            ))}
          </View>
        </View>

        <View style={styles.divider} />

        {/* ── Plan Details ── */}
        <Text style={[styles.sectionHeaderLabel, { color: colors.text }]}>Plan Details</Text>

        {/* ── Section: Number of days ── */}
        <Section title="Number of Days" colors={colors}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {DAYS_OPTIONS.map((n) => (
                <Chip
                  key={n}
                  label={String(n)}
                  selected={days === n}
                  onPress={() => setDays(n)}
                  colors={colors}
                />
              ))}
            </View>
          </ScrollView>
        </Section>

        {/* ── Section: Start Date ── */}
        <Section title="Start Date" colors={colors}>
          <View style={styles.dateNavRow}>
            <TouchableOpacity
              style={[styles.dateNavBtn, { borderColor: '#D1D5DB' }]}
              onPress={() => setStartDate((d) => addDays(d, -1))}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.dateNavLabel, { color: colors.text }]}>
              {formatDateDisplay(formatDateISO(startDate))}
            </Text>
            <TouchableOpacity
              style={[styles.dateNavBtn, { borderColor: '#D1D5DB' }]}
              onPress={() => setStartDate((d) => addDays(d, 1))}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="chevron-forward" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
        </Section>

        {/* ── Section: Servings ── */}
        <Section title="Servings" colors={colors}>
          <View style={styles.servingsRow}>
            <CounterField
              label="Adults"
              value={adults}
              onDecrement={() => setAdults((v) => Math.max(1, v - 1))}
              onIncrement={() => setAdults((v) => Math.min(20, v + 1))}
              colors={colors}
            />
            <CounterField
              label="Children"
              value={children}
              onDecrement={() => setChildren((v) => Math.max(0, v - 1))}
              onIncrement={() => setChildren((v) => Math.min(20, v + 1))}
              colors={colors}
            />
          </View>
        </Section>

        {/* ── Section: Meal types ── */}
        <Section title="Meal Types" colors={colors}>
          {MEAL_TYPE_OPTIONS.map(({ type, label, icon }) => {
            const active = mealTypes.includes(type);
            return (
              <TouchableOpacity
                key={type}
                style={[
                  styles.checkRow,
                  { borderColor: active ? colors.primary : '#D1D5DB' },
                  active && { backgroundColor: colors.primaryLight },
                ]}
                onPress={() => toggleMealType(type)}
                activeOpacity={0.7}
              >
                <View
                  style={[
                    styles.checkbox,
                    { borderColor: active ? colors.primary : '#D1D5DB' },
                    active && { backgroundColor: colors.primary },
                  ]}
                >
                  {active && <Ionicons name="checkmark" size={12} color="#fff" />}
                </View>
                <Ionicons name={icon as any} size={18} color={active ? colors.primary : colors.textSecondary} />
                <Text style={[styles.checkLabel, { color: active ? colors.text : colors.textSecondary }]}>
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </Section>

        {/* ── Section: Ingredient Seeds ── */}
        <Section title="Ingredient Seeds" colors={colors}>
          <Text style={[styles.seedsHint, { color: colors.textTertiary }]}>
            Select ingredients to lean the plan toward
          </Text>
          <View style={styles.materialsGrid}>
            {MAT_OPTIONS.map((mat) => (
              <PastelCard
                key={mat.id}
                title={mat.id}
                emoji={mat.emoji}
                selectedColorHex={mat.bg}
                selected={selectedMaterials.has(mat.id)}
                onPress={() => {
                  setSelectedMaterials(prev => {
                    const next = new Set(prev);
                    next.has(mat.id) ? next.delete(mat.id) : next.add(mat.id);
                    return next;
                  });
                }}
              />
            ))}
          </View>
        </Section>

        {/* ── Section: Additional Requests ── */}
        <Section title="Additional Requests" colors={colors}>
          <TextInput
            style={[
              styles.textArea,
              {
                backgroundColor: colors.inputBackground,
                color: colors.text,
                borderColor: '#D1D5DB',
              },
            ]}
            value={customInstructions}
            onChangeText={setCustomInstructions}
            placeholder='e.g. "No nuts, low carb, dairy free"'
            placeholderTextColor={colors.textTertiary}
            multiline
            numberOfLines={3}
          />
        </Section>

      </ScrollView>

      {/* Floating Generate CTA */}
      <View style={{ position: 'absolute', bottom: Spacing.xl, left: Spacing.xl, right: Spacing.xl }}>
        <TouchableOpacity
          style={[styles.generateBtn, { backgroundColor: colors.primary, marginTop: 0 }, Shadows.md]}
          onPress={handleGenerate}
          activeOpacity={0.85}
        >
          <Ionicons name="sparkles-outline" size={20} color="#fff" />
          <Text style={styles.generateBtnText}>Generate</Text>
        </TouchableOpacity>
      </View>

      {householdId && (
        <SettingsModal
          visible={settingsVisible}
          onClose={() => setSettingsVisible(false)}
          householdId={householdId}
          onSaved={() =>
            getHouseholdSettings(householdId).then(setSettings).catch(() => { })
          }
        />
      )}
    </SafeAreaView>
  );
}

// ─── Loading Screen ───────────────────────────────────────────

function LoadingScreen({
  colors,
  message,
  progress,
}: {
  colors: (typeof Colors)['light'];
  message: string;
  progress: { current: number; total: number };
}) {
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
      <View style={styles.loadingCenter}>
        <View style={[styles.loadingCard, { backgroundColor: colors.surface }, Shadows.lg]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingMsg, { color: colors.text }]}>{message}</Text>
          {progress.total > 0 && (
            <Text style={[styles.loadingProgress, { color: colors.textSecondary }]}>
              Recipe {progress.current} of {progress.total}
            </Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Results Screen ───────────────────────────────────────────

const ResultsScreen = React.memo(function ResultsScreen({
  colors,
  meals,
  checkedIndices,
  onToggleCheck,
  onPreview,
  onRegenerate,
  onRegenerateMismatched,
  onAddToCalendar,
  onBack,
  effort,
  onEffortChange,
  modifiers,
  onToggleModifier,
  selectedCuisines,
  onToggleCuisineSelection,
  selectedMaterials,
  onToggleMaterial,
}: {
  colors: (typeof Colors)['light'];
  meals: GeneratedMeal[];
  checkedIndices: Set<number>;
  onToggleCheck: (i: number) => void;
  onPreview: (r: Recipe) => void;
  onRegenerate: () => void;
  onRegenerateMismatched: () => void;
  onAddToCalendar: () => void;
  onBack: () => void;
  effort: EffortValue;
  onEffortChange: (v: EffortValue) => void;
  modifiers: Set<CuisineStyle>;
  onToggleModifier: (s: CuisineStyle) => void;
  selectedCuisines: Set<CuisineStyle>;
  onToggleCuisineSelection: (s: CuisineStyle) => void;
  selectedMaterials: Set<string>;
  onToggleMaterial: (id: string) => void;
}) {
  const checkedCount = checkedIndices.size;
  const [preferencesExpanded, setPreferencesExpanded] = useState(false);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
      {/* Results header */}
      <View style={[styles.resultsHeader, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.resultsTitle, { color: colors.text }]}>Your Meal Plan</Text>
        <View style={{ width: 24 }} />
      </View>

      <FlatList
        data={meals}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={[styles.resultsList, { paddingBottom: Spacing.huge + 160 }]}
        renderItem={({ item, index }) => (
          <MealResultCard
            meal={item}
            checked={checkedIndices.has(index)}
            onToggle={() => onToggleCheck(index)}
            onPreview={() => onPreview(item.recipe)}
            colors={colors}
          />
        )}
        ListFooterComponent={
          <View style={styles.resultsFooter}>
            {/* ── Adjust preferences toggle ── */}
            <TouchableOpacity
              style={styles.preferencesToggle}
              onPress={() => setPreferencesExpanded((v) => !v)}
              activeOpacity={0.7}
            >
              <View style={[styles.preferencesDividerLine, { backgroundColor: colors.border }]} />
              <Text style={[styles.preferencesToggleLabel, { color: colors.textSecondary }]}>
                Adjust Preferences
              </Text>
              <Ionicons
                name={preferencesExpanded ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={colors.textSecondary}
              />
              <View style={[styles.preferencesDividerLine, { backgroundColor: colors.border }]} />
            </TouchableOpacity>

            {preferencesExpanded && (
              <>
                <Text style={[styles.regenSectionLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>EFFORT</Text>
                <View style={styles.effortRow}>
                  {EFFORT_OPTIONS.map(({ value, label, emoji }) => {
                    const active = effort === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={[styles.effortBtn, { backgroundColor: colors.surface }, active && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                        onPress={() => onEffortChange(effort === value && value !== 'No Restriction' ? 'No Restriction' : value)}
                        activeOpacity={0.75}
                      >
                        <Text style={styles.effortEmoji}>{emoji}</Text>
                        <Text style={[styles.effortLabel, { color: active ? '#fff' : colors.text }]}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={[styles.regenSectionLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>MODIFIERS</Text>
                <View style={styles.materialsGrid}>
                  {MODIFIER_OPTIONS.map(({ style, emoji, bg }) => (
                    <PastelCard
                      key={style}
                      title={style}
                      emoji={emoji}
                      selectedColorHex={bg}
                      selected={modifiers.has(style)}
                      onPress={() => onToggleModifier(style)}
                      cardWidth={CUISINE_CARD_W}
                    />
                  ))}
                </View>

                <Text style={[styles.regenSectionLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>CUISINES</Text>
                <View style={styles.materialsGrid}>
                  {CUISINE_OPTION_LIST.map(({ style, emoji, bg }) => (
                    <PastelCard
                      key={style}
                      title={style}
                      emoji={emoji}
                      selectedColorHex={bg}
                      selected={selectedCuisines.has(style)}
                      onPress={() => onToggleCuisineSelection(style)}
                      cardWidth={CUISINE_CARD_W}
                    />
                  ))}
                </View>

                <Text style={[styles.regenSectionLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>
                  Ingredient Seeds
                </Text>
                <View style={[styles.materialsGrid, { marginBottom: Spacing.xl }]}>
                  {MAT_OPTIONS.map((mat) => (
                    <PastelCard
                      key={mat.id}
                      title={mat.id}
                      emoji={mat.emoji}
                      selectedColorHex={mat.bg}
                      selected={selectedMaterials.has(mat.id)}
                      onPress={() => onToggleMaterial(mat.id)}
                    />
                  ))}
                </View>
              </>
            )}
          </View>
        }
      />

      {/* Floating action bar */}
      <View style={{ position: 'absolute', bottom: Spacing.xl, left: Spacing.xl, right: Spacing.xl, gap: Spacing.sm }}>

        {/* TOP ROW: Auto-fix & Regen */}
        <View style={styles.floatingCtaRow}>
          <TouchableOpacity
            style={[styles.secondaryBtn, { backgroundColor: colors.surface, borderColor: colors.border, flex: 1 }, Shadows.md]}
            onPress={onRegenerateMismatched}
            activeOpacity={0.8}
          >
            <Ionicons name="warning-outline" size={18} color={colors.textSecondary} />
            <Text style={[styles.secondaryBtnText, {
              color: colors.textSecondary,
              flexShrink: 1, // Allows the text to wrap instead of overflowing
              textAlign: 'center', // Centers the wrapped text nicely
              marginLeft: 4 // Optional: Adds breathing room between the icon and text
            }]}>
              Auto Fix
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.secondaryBtn,
              { backgroundColor: colors.surface, borderColor: colors.primary, flex: 1 },
              checkedCount === 0 && styles.btnDisabled,
              Shadows.md
            ]}
            onPress={onRegenerate}
            disabled={checkedCount === 0}
            activeOpacity={0.8}
          >
            <Ionicons name="refresh" size={18} color={checkedCount === 0 ? colors.textTertiary : colors.primary} />
            <Text style={[styles.secondaryBtnText, {
              color: checkedCount === 0 ? colors.textTertiary : colors.primary,
              flexShrink: 1,
              textAlign: 'center',
              marginLeft: 4
            }]}>
              Regenerate ({checkedCount})
            </Text>
          </TouchableOpacity>
        </View>

        {/* BOTTOM ROW: Add to Calendar */}
        <TouchableOpacity
          style={[styles.generateBtn, { backgroundColor: colors.primary, marginTop: 0 }, Shadows.md]}
          onPress={onAddToCalendar}
          activeOpacity={0.85}
        >
          <Ionicons name="calendar" size={20} color="#fff" />
          <Text style={styles.generateBtnText}>Add to Calendar</Text>
        </TouchableOpacity>

      </View>
    </SafeAreaView>
  );
});

const MealResultCard = React.memo(function MealResultCard({
  meal,
  checked,
  onToggle,
  onPreview,
  colors,
}: {
  meal: GeneratedMeal;
  checked: boolean;
  onToggle: () => void;
  onPreview: () => void;
  colors: (typeof Colors)['light'];
}) {
  return (
    <TouchableOpacity
      style={[styles.resultCard, { backgroundColor: colors.surface }, Shadows.sm]}
      onPress={onPreview}
      activeOpacity={0.75}
    >
      <TouchableOpacity
        style={[
          styles.resultCheckbox,
          { borderColor: checked ? colors.primary : colors.border },
          checked && { backgroundColor: colors.primary },
        ]}
        onPress={onToggle}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {checked && <Ionicons name="checkmark" size={14} color="#fff" />}
      </TouchableOpacity>

      <View style={styles.resultContent}>
        <View style={styles.resultMeta}>
          <View style={[styles.mealTypeBadge, { backgroundColor: colors.primaryLight }]}>
            <Text style={[styles.mealTypeText, { color: colors.primary }]}>
              {MEAL_LABELS[meal.mealType]}
            </Text>
          </View>
          {meal.isFromFavourites && (
            <View style={[styles.favBadge, { backgroundColor: colors.accentLight }]}>
              <Ionicons name="star" size={10} color={colors.accent} />
              <Text style={[styles.favText, { color: colors.accent }]}>Favourite</Text>
            </View>
          )}
          <Text style={[styles.resultDate, { color: colors.textSecondary }]}>
            {formatDateDisplay(meal.date)}
          </Text>
        </View>

        <Text style={[styles.resultRecipeName, { color: colors.text }]} numberOfLines={2}>
          {meal.recipe.title}
        </Text>

        <View style={styles.resultTimings}>
          <Ionicons name="time-outline" size={12} color={colors.textTertiary} />
          <Text style={[styles.resultTimingText, { color: colors.textTertiary }]}>
            {meal.recipe.totalTime
              ? `${meal.recipe.totalTime} total`
              : `${meal.recipe.prepTime} prep · ${meal.recipe.cookTime} cook`}
          </Text>
        </View>

        {((meal.recipe.course?.length ?? 0) + (meal.recipe.tags?.length ?? 0)) > 0 ? (
          <View style={styles.resultCoursePills}>
            {[...(meal.recipe.course ?? []), ...(meal.recipe.tags ?? [])].map((label, i) => (
              <View key={i} style={[styles.resultCoursePill, { borderColor: colors.border }]}>
                <Text style={[styles.resultCoursePillText, { color: colors.textSecondary }]}>
                  {label.replace(/\b\w/g, (ch) => ch.toUpperCase())}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {meal.recipe.imageUrl ? (
        <Image source={{ uri: meal.recipe.imageUrl }} style={styles.resultCardImage} />
      ) : null}

      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </TouchableOpacity>
  );
});

// ─── Shared sub-components ────────────────────────────────────

function Section({
  title,
  children,
  colors,
}: {
  title: string;
  children: React.ReactNode;
  colors: (typeof Colors)['light'];
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{title}</Text>
      {children}
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  colors,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  colors: (typeof Colors)['light'];
}) {
  return (
    <TouchableOpacity
      style={[
        styles.chip,
        selected
          ? { backgroundColor: colors.primary, borderColor: colors.primary }
          : { backgroundColor: colors.surface, borderColor: '#D1D5DB' },
      ]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Text style={[styles.chipText, { color: selected ? '#fff' : colors.textSecondary }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function CounterField({
  label,
  hint,
  value,
  onDecrement,
  onIncrement,
  colors,
}: {
  label: string;
  hint?: string;
  value: number;
  onDecrement: () => void;
  onIncrement: () => void;
  colors: (typeof Colors)['light'];
}) {
  return (
    <View style={[styles.counterField, { backgroundColor: colors.surface }, Shadows.sm]}>
      <Text style={[styles.counterLabel, { color: colors.text }]}>{label}</Text>
      {hint && (
        <Text style={[styles.counterHint, { color: colors.textTertiary }]}>{hint}</Text>
      )}
      <View style={styles.counterRow}>
        <AnimatedPressable
          style={[{ opacity: value <= 1 ? 0.3 : 1 }]}
          onPress={onDecrement}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="remove-circle-outline" size={32} color={colors.text} />
        </AnimatedPressable>
        <Text style={[styles.counterValue, { color: colors.text }]}>{value}</Text>
        <AnimatedPressable
          onPress={onIncrement}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="add-circle-outline" size={32} color={colors.text} />
        </AnimatedPressable>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.huge,
  },

  header: { marginBottom: Spacing.md },
  gearBtn: { alignSelf: 'flex-end', marginTop: Spacing.xxs, marginBottom: Spacing.xxs },
  topLabel: { fontFamily: Fonts.bold, fontSize: FontSizes.md, marginBottom: Spacing.xs },
  title: { fontSize: FontSizes.xxxl, fontFamily: Fonts.bold, lineHeight: 42, marginBottom: Spacing.sm },
  pillSubText: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  subtitle: { fontSize: FontSizes.sm, fontFamily: Fonts.medium },

  materialsWrapper: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  materialsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
    justifyContent: 'center',
  },
  styleGroupLabel: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    alignSelf: 'flex-start',
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
  effortRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    width: '100%',
  },
  effortBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
  },
  effortEmoji: { fontSize: 14 },
  effortLabel: { fontSize: FontSizes.xs, fontFamily: Fonts.semibold },

  divider: {
    height: 1,
    backgroundColor: '#E7E5E4',
    marginVertical: Spacing.xxl,
    marginHorizontal: Spacing.md,
  },
  preferencesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
    marginHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  preferencesDividerLine: {
    flex: 1,
    height: 1,
  },
  preferencesToggleLabel: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHeaderLabel: {
    fontSize: FontSizes.xl,
    fontFamily: Fonts.bold,
    marginBottom: Spacing.lg,
  },

  section: { marginBottom: Spacing.xl },
  sectionTitle: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    marginBottom: Spacing.md,
  },

  // Chips
  seedsHint: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    marginBottom: Spacing.md,
  },

  chipRow: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.xs },
  cuisineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  chip: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
  },
  chipText: { fontSize: FontSizes.sm, fontFamily: Fonts.bold },

  // Start date navigator
  dateNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
  },
  dateNavBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dateNavLabel: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.semibold,
    minWidth: 120,
    textAlign: 'center',
  },

  // Servings
  servingsRow: { flexDirection: 'row', gap: Spacing.md },
  counterField: {
    flex: 1,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: '#E7E5E4',
  },
  counterLabel: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },
  counterHint: { fontSize: FontSizes.xs },
  counterRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.xs },
  counterBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  counterValue: { fontSize: FontSizes.xl, fontFamily: Fonts.bold, minWidth: 32, textAlign: 'center' },

  // Meal type checkboxes
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    marginBottom: Spacing.sm,
    backgroundColor: '#FFFFFF',
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: Radius.xs,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkLabel: { fontSize: FontSizes.md, fontFamily: Fonts.medium },

  // Custom instructions textarea
  textArea: {
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Spacing.md,
    fontSize: FontSizes.md,
    minHeight: 72,
    textAlignVertical: 'top',
  },

  // Buttons
  generateBtn: {
    width: '100%',
    flexDirection: 'row',
    paddingVertical: Spacing.lg,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  generateBtnText: {
    color: '#fff',
    fontSize: FontSizes.xl,
    fontFamily: Fonts.bold,
  },
  // Loading
  loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  loadingCard: {
    borderRadius: Radius.xxl,
    padding: Spacing.xxxl,
    alignItems: 'center',
    gap: Spacing.lg,
    width: '100%',
  },
  loadingMsg: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.medium,
    textAlign: 'center',
    lineHeight: 22,
  },
  loadingProgress: { fontSize: FontSizes.sm },

  // Regen options header (shown at top of results list)
  regenOptions: {
    marginBottom: Spacing.lg,
  },
  regenSectionLabel: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.md,
  },

  // Results
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  resultsTitle: { fontSize: FontSizes.xl, fontFamily: Fonts.bold },
  resultsList: { padding: Spacing.xl, gap: Spacing.md },
  resultsFooter: { gap: Spacing.md, paddingTop: Spacing.md },

  resultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
  },
  resultCheckbox: {
    width: 24,
    height: 24,
    borderRadius: Radius.xs,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  resultContent: { flex: 1, gap: Spacing.xs },
  resultMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flexWrap: 'wrap' },
  mealTypeBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  mealTypeText: { fontSize: FontSizes.xs, fontFamily: Fonts.semibold },
  favBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  favText: { fontSize: FontSizes.xs, fontFamily: Fonts.semibold },
  resultDate: { fontSize: FontSizes.xs },
  resultRecipeName: { fontSize: FontSizes.md, fontFamily: Fonts.semibold, lineHeight: 20 },
  resultTimings: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  resultTimingText: { fontSize: FontSizes.xs },
  resultCoursePills: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginTop: Spacing.xs },
  resultCoursePill: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  resultCoursePillText: { fontSize: FontSizes.xs, fontFamily: Fonts.medium },

  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
  },
  secondaryBtnText: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },
  btnDisabled: { opacity: 0.4 },

  floatingCta: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xl,
    borderTopWidth: 1,
    gap: Spacing.sm,
  },
  floatingCtaRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },

  resultCardImage: {
    width: 72,
    height: 72,
    borderRadius: Radius.md,
    flexShrink: 0,
    backgroundColor: '#E7E5E4',
  },
});
