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
import {
  addDays,
  confirmMealPlan,
  formatDateDisplay,
  formatDateISO,
  generateMealPlan,
  getNextMonday,
  regenerateMeals,
  type GenerateConfig,
  type GeneratedMeal,
} from '@/services/generatorService';
import { clearAllCachedRecipes, getHouseholdSettings } from '@/services/firestoreService';
import type { CuisineStyle, HouseholdSettings, MealType, Recipe } from '@/services/types';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Force Light Mode colors for this design overhaul
const colors = Colors.light;

// 2-column cuisine card: fills the horizontal padding with one gap in the middle
const { width: SCREEN_W } = Dimensions.get('window');
const CUISINE_CARD_W = (SCREEN_W - Spacing.xl * 2 - Spacing.md * 2) / 3;

// ─── Constants ────────────────────────────────────────────────

const MAT_OPTIONS = [
  { id: 'Chicken', emoji: '🍗', bg: colors.caloriesBadge },
  { id: 'Meat', emoji: '🥩', bg: colors.proteinBadge },
  { id: 'Fish', emoji: '🐟', bg: colors.carbsBadge },
  { id: 'Egg', emoji: '🥚', bg: colors.fatBadge },
  { id: 'Broccoli', emoji: '🥦', bg: colors.proteinBadge },
  { id: 'Tomato', emoji: '🍅', bg: colors.caloriesBadge },
  { id: 'Pasta', emoji: '🍝', bg: colors.caloriesBadge },
  { id: 'Rice', emoji: '🍚', bg: colors.carbsBadge },
  { id: 'Potato', emoji: '🥔', bg: colors.fatBadge },
  { id: 'Carrot', emoji: '🥕', bg: colors.caloriesBadge },
  { id: 'Cheese', emoji: '🧀', bg: colors.caloriesBadge },
  { id: 'Lettuce', emoji: '🥬', bg: colors.proteinBadge },
];

const DAYS_OPTIONS = [1, 2, 3, 4, 5, 6, 7];

const CUISINE_OPTIONS: { style: CuisineStyle; emoji: string; bg: string }[] = [
  { style: 'Quick & Easy', emoji: '⚡', bg: colors.caloriesBadge },
  { style: 'Moderate', emoji: '🍳', bg: colors.carbsBadge },
  { style: 'Vegetarian', emoji: '🥗', bg: colors.proteinBadge },
  { style: 'Kid Friendly', emoji: '👧', bg: colors.fatBadge },
  { style: 'Asian', emoji: '🍜', bg: colors.carbsBadge },
  { style: 'Mexican', emoji: '🌮', bg: colors.caloriesBadge },
  { style: 'Mediterranean', emoji: '🫒', bg: colors.proteinBadge },
  { style: 'Healthy', emoji: '🥑', bg: colors.proteinBadge },
  { style: 'Salad', emoji: '🥬', bg: colors.caloriesBadge },
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

  // ── Settings state ──
  const [settings, setSettings] = useState<HouseholdSettings>({ sourceWeights: {}, ingredientWeights: {} });
  const [settingsVisible, setSettingsVisible] = useState(false);

  useEffect(() => {
    if (!householdId) return;
    getHouseholdSettings(householdId).then(setSettings).catch(() => {});
  }, [householdId]);

  // ── Form state ──
  const [days, setDays] = useState(5);
  const [startDate, setStartDate] = useState<Date>(getNextMonday);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(2);
  const [mealTypes, setMealTypes] = useState<MealType[]>(['dinner']);
  const [cuisines, setCuisines] = useState<CuisineStyle[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(new Set());

  // ── Flow state ──
  const [phase, setPhase] = useState<Phase>('configure');
  const [loadingMsg, setLoadingMsg] = useState('');
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [generatedMeals, setGeneratedMeals] = useState<GeneratedMeal[]>([]);
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(new Set());
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);

  // ── Helpers ──
  const toggleMealType = (t: MealType) =>
    setMealTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );

  const toggleCuisine = (s: CuisineStyle) =>
    setCuisines((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );

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

    const matStr = Array.from(selectedMaterials).join(', ');
    const combinedInstructions = [matStr, customInstructions.trim()].filter(Boolean).join('. ');
    return {
      startDate,
      numberOfDays: days,
      adults,
      children,
      mealTypes,
      cuisineStyles: cuisines,
      customInstructions: combinedInstructions || undefined,
      settings,
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
      setPhase('results');
    } catch (err) {
      setPhase('configure');
      Alert.alert(
        'Generation failed',
        err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      );
    }
  }, [householdId, days, startDate, adults, children, mealTypes, cuisines, customInstructions]);

  // ── Regenerate selected ──
  const handleRegenerate = useCallback(async () => {
    if (!householdId) return;
    const indices = Array.from(checkedIndices);
    if (indices.length === 0) return;

    setPhase('generating');
    setLoadingMsg('Regenerating selected recipes…');
    setLoadingProgress({ current: 0, total: indices.length });

    try {
      const updated = await regenerateMeals(
        generatedMeals,
        indices,
        { cuisineStyles: cuisines, customInstructions: customInstructions.trim() || undefined, adults, children, settings },
        (msg, current, total) => {
          setLoadingMsg(msg);
          setLoadingProgress({ current, total });
        }
      );
      setGeneratedMeals(updated);
      setCheckedIndices(new Set());
      setPhase('results');
    } catch (err) {
      setPhase('results');
      Alert.alert('Regeneration failed', err instanceof Error ? err.message : 'Please try again.');
    }
  }, [householdId, checkedIndices, generatedMeals, cuisines, customInstructions, adults, children]);

  // ── Add to calendar ──
  const handleAddToCalendar = useCallback(async () => {
    if (!householdId) return;
    setPhase('saving');
    try {
      await confirmMealPlan(generatedMeals, householdId);
      setPhase('configure');
      setGeneratedMeals([]);
      setCheckedIndices(new Set());
      Alert.alert('Done!', 'Your meal plan has been added to the calendar and shopping list.');
    } catch (err) {
      setPhase('results');
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Please try again.');
    }
  }, [householdId, generatedMeals]);

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
          onAddToCalendar={handleAddToCalendar}
          onBack={() => setPhase('configure')}
          cuisines={cuisines}
          onToggleCuisine={toggleCuisine}
          selectedMaterials={selectedMaterials}
          onToggleMaterial={(id) =>
            setSelectedMaterials((prev) => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            })
          }
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
        />
      </>
    );
  }

  // ── Configure phase ───────────────────────────────────────
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
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
          <View style={[styles.pillSubText, { backgroundColor: '#E7E5E4' }]}>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              Pick one or more styles
            </Text>
          </View>
        </View>

        {/* ── Section: Recipe Style (2-column PastelCard grid — hero section) ── */}
        <View style={styles.materialsWrapper}>
          <View style={styles.materialsGrid}>
            {CUISINE_OPTIONS.map(({ style, emoji, bg }) => (
              <PastelCard
                key={style}
                title={style}
                emoji={emoji}
                selectedColorHex={bg}
                selected={cuisines.includes(style)}
                onPress={() => toggleCuisine(style)}
                cardWidth={CUISINE_CARD_W}
              />
            ))}
          </View>
        </View>

        {/* ── Generate button ── */}
        <TouchableOpacity
          style={[styles.generateBtn, { backgroundColor: colors.primary }]}
          onPress={handleGenerate}
          activeOpacity={0.85}
        >
          <Ionicons name="sparkles-outline" size={20} color="#fff" />
          <Text style={styles.generateBtnText}>Generate</Text>
        </TouchableOpacity>

        {/* ── Dev: Clear recipe cache ── */}
        <TouchableOpacity
          onPress={() => {
            Alert.alert(
              'Clear Recipe Cache',
              'Delete all cached recipes so they are re-scraped on next generation. Continue?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      const count = await clearAllCachedRecipes();
                      Alert.alert('Cache Cleared', `${count} cached recipe${count !== 1 ? 's' : ''} deleted.`);
                    } catch (err) {
                      Alert.alert('Error', 'Failed to clear cache.');
                    }
                  },
                },
              ]
            );
          }}
          activeOpacity={0.7}
          style={{ alignSelf: 'center', marginTop: Spacing.sm }}
        >
          <Text style={{ fontSize: FontSizes.sm, color: colors.textSecondary, fontFamily: Fonts.regular }}>
            Clear Recipe Cache
          </Text>
        </TouchableOpacity>

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

      {householdId && (
        <SettingsModal
          visible={settingsVisible}
          onClose={() => setSettingsVisible(false)}
          householdId={householdId}
          onSaved={() =>
            getHouseholdSettings(householdId).then(setSettings).catch(() => {})
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
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
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
  onAddToCalendar,
  onBack,
  cuisines,
  onToggleCuisine,
  selectedMaterials,
  onToggleMaterial,
}: {
  colors: (typeof Colors)['light'];
  meals: GeneratedMeal[];
  checkedIndices: Set<number>;
  onToggleCheck: (i: number) => void;
  onPreview: (r: Recipe) => void;
  onRegenerate: () => void;
  onAddToCalendar: () => void;
  onBack: () => void;
  cuisines: CuisineStyle[];
  onToggleCuisine: (s: CuisineStyle) => void;
  selectedMaterials: Set<string>;
  onToggleMaterial: (id: string) => void;
}) {
  const checkedCount = checkedIndices.size;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
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
        contentContainerStyle={styles.resultsList}
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
            {/* ── Re-generation options ── */}
            <View style={[styles.divider, { marginTop: Spacing.xs }]} />
            <Text style={[styles.regenSectionLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>Recipe Style</Text>
            <View style={styles.materialsGrid}>
              {CUISINE_OPTIONS.map(({ style, emoji, bg }) => (
                <PastelCard
                  key={style}
                  title={style}
                  emoji={emoji}
                  selectedColorHex={bg}
                  selected={cuisines.includes(style)}
                  onPress={() => onToggleCuisine(style)}
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

            {/* ── Action buttons ── */}
            <TouchableOpacity
              style={[
                styles.secondaryBtn,
                { borderColor: colors.primary },
                checkedCount === 0 && styles.btnDisabled,
              ]}
              onPress={onRegenerate}
              disabled={checkedCount === 0}
              activeOpacity={0.8}
            >
              <Ionicons
                name="refresh"
                size={18}
                color={checkedCount === 0 ? colors.textTertiary : colors.primary}
              />
              <Text
                style={[
                  styles.secondaryBtnText,
                  { color: checkedCount === 0 ? colors.textTertiary : colors.primary },
                ]}
              >
                Regenerate Selected ({checkedCount})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.generateBtn, { backgroundColor: colors.primary }]}
              onPress={onAddToCalendar}
              activeOpacity={0.85}
            >
              <Ionicons name="calendar" size={20} color="#fff" />
              <Text style={styles.generateBtnText}>Add to Calendar</Text>
            </TouchableOpacity>
          </View>
        }
      />
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

        {meal.recipe.course && meal.recipe.course.length > 0 && (
          <View style={styles.resultCoursePills}>
            {meal.recipe.course.map((c, i) => (
              <View key={i} style={[styles.resultCoursePill, { borderColor: colors.border }]}>
                <Text style={[styles.resultCoursePillText, { color: colors.textSecondary }]}>
                  {c.replace(/\b\w/g, (ch) => ch.toUpperCase())}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

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
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.huge,
  },

  header: { marginBottom: Spacing.xxl },
  gearBtn: { alignSelf: 'flex-end', marginBottom: Spacing.sm },
  topLabel: { fontFamily: Fonts.bold, fontSize: FontSizes.md, marginBottom: Spacing.sm },
  title: { fontSize: FontSizes.xxxl, fontFamily: Fonts.bold, lineHeight: 42, marginBottom: Spacing.md },
  pillSubText: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  subtitle: { fontSize: FontSizes.sm, fontFamily: Fonts.medium },

  materialsWrapper: {
    alignItems: 'center',
    marginBottom: Spacing.xxl,
  },
  materialsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
    justifyContent: 'center',
  },

  divider: {
    height: 1,
    backgroundColor: '#E7E5E4',
    marginVertical: Spacing.xxl,
    marginHorizontal: Spacing.md,
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
    marginTop: Spacing.md,
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
  resultCoursePillText: { fontSize: FontSizes.xs, fontFamily: Fonts.regular },

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
});
