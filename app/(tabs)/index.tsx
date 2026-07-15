// ============================================================
// Meal Wizard — Calendar Tab
// Weekly carousel (today centred) and monthly grid with recipe
// names on day cells. Real-time Firestore subscription.
// ============================================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  Image,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSizes, Fonts, Spacing, Radius, Shadows } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import {
  subscribeMealPlan,
  subscribeCookbook,
  toggleStarred,
  deleteMealPlanEntry,
  getRecipe,
} from '@/services/firestoreService';
import RecipeDetailModal from '@/components/RecipeDetailModal';
import type { CookbookEntry, MealPlanEntry, Recipe, MealType } from '@/services/types';
import {
  getRecipePresentation,
  reconcileRecipeAvailability,
} from '@/services/recipeAvailability';

// ─── Layout constants ─────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_GAP = 12;
const CARD_WIDTH = SCREEN_WIDTH * 0.8;
const CARD_SIDE_PAD = (SCREEN_WIDTH - CARD_WIDTH) / 2;

// ─── Date helpers ─────────────────────────────────────────────

function getThisMonday(): Date {
  const today = new Date();
  const dow = today.getDay(); // 0 = Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  const d = new Date(today);
  d.setDate(today.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function shiftDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatWeekRange(monday: Date): string {
  const sunday = shiftDays(monday, 6);
  const mStr = monday.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const sStr = sunday.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${mStr} – ${sStr}`;
}

function formatMonthYear(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

function buildMonthGrid(year: number, month: number): (Date | null)[][] {
  const first = new Date(year, month, 1);
  const lastDate = new Date(year, month + 1, 0).getDate();
  const startDow = (first.getDay() + 6) % 7; // Mon = 0
  const cells: (Date | null)[] = Array(startDow).fill(null);
  for (let d = 1; d <= lastDate; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

// Truncate a recipe title to fit in a small month cell
function abbreviateTitle(title: string, maxLen = 10): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 1) + '…';
}

const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'side'];
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  side: 'Side',
};

function mealBadge(type: MealType, colors: (typeof Colors)['light']) {
  if (type === 'breakfast') return { bg: colors.caloriesBadge, fg: colors.caloriesText };
  if (type === 'lunch')     return { bg: colors.carbsBadge,    fg: colors.carbsText };
  if (type === 'side')      return { bg: colors.fatBadge,      fg: colors.fatText };
  return                           { bg: colors.proteinBadge,  fg: colors.proteinText };
}

// ─── Screen ───────────────────────────────────────────────────

export default function CalendarScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { householdId } = useAuth();

  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [weekStart, setWeekStart] = useState<Date>(getThisMonday);
  const [monthYear, setMonthYear] = useState(() => {
    const n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() };
  });

  const [entries, setEntries] = useState<MealPlanEntry[]>([]);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const [missingRecipeIds, setMissingRecipeIds] = useState<Set<string>>(new Set());
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);
  const [cookbook, setCookbook] = useState<CookbookEntry[]>([]);
  const [previewEntry, setPreviewEntry] = useState<{
    id: string;
    adults?: number;
    children?: number;
    servings?: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const carouselRef = useRef<FlatList<Date>>(null);

  // ── Real-time subscription ──
  useEffect(() => {
    if (!householdId) return;
    const unsub = subscribeMealPlan(householdId, (e) => {
      setEntries(e);
      setLoading(false);
    });
    return unsub;
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    return subscribeCookbook(householdId, setCookbook);
  }, [householdId]);

  // ── Lazy recipe loading ──
  useEffect(() => {
    const toLoad = [...new Set(entries.map((e) => e.recipeId))].filter(
      (id) => !loadedIdsRef.current.has(id)
    );
    if (!toLoad.length) return;
    toLoad.forEach((id) => loadedIdsRef.current.add(id));
    Promise.all(toLoad.map(getRecipe)).then((fetched) => {
      setRecipes((previous) =>
        reconcileRecipeAvailability(toLoad, fetched, previous, new Set()).recipes
      );
      setMissingRecipeIds((previous) =>
        reconcileRecipeAvailability<Recipe>(toLoad, fetched, {}, previous).missingRecipeIds
      );
    });
  }, [entries]);

  const forDate = useCallback(
    (dateStr: string) =>
      entries
        .filter((e) => e.date === dateStr)
        .sort((a, b) => MEAL_ORDER.indexOf(a.mealType) - MEAL_ORDER.indexOf(b.mealType)),
    [entries]
  );

  const handleDelete = useCallback(
    (entry: MealPlanEntry) => {
      if (!householdId || !entry.id) return;
      const title = recipes[entry.recipeId]?.title ?? 'this meal';
      Alert.alert('Remove meal', `Remove "${title}" from ${entry.date}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => deleteMealPlanEntry(householdId, entry.id!),
        },
      ]);
    },
    [householdId, recipes]
  );

  const today = toISO(new Date());
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => shiftDays(weekStart, i)),
    [weekStart]
  );
  const monthGrid = buildMonthGrid(monthYear.year, monthYear.month);

  // Index of today within the current week (0–6); -1 if not this week
  const todayCarouselIndex = useMemo(() => {
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const diff = Math.round((todayDate.getTime() - weekStart.getTime()) / 86400000);
    return diff >= 0 && diff <= 6 ? diff : -1;
  }, [weekStart]);

  // Scroll carousel to today (or index 0) whenever week changes
  const scrollCarouselToToday = useCallback(() => {
    const idx = todayCarouselIndex >= 0 ? todayCarouselIndex : 0;
    carouselRef.current?.scrollToOffset({
      offset: idx * (CARD_WIDTH + CARD_GAP),
      animated: false,
    });
  }, [todayCarouselIndex]);

  // Re-scroll carousel when user navigates to a different week
  useEffect(() => {
    const t = setTimeout(scrollCarouselToToday, 30);
    return () => clearTimeout(t);
  }, [weekStart]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
      {/* ── Screen header ── */}
      <View style={s.screenHeader}>
        <Text style={[s.screenTitle, { color: colors.text }]}>Calendar</Text>
        <View style={[s.toggle, { backgroundColor: colors.surface }]}>
          {(['week', 'month'] as const).map((mode) => (
            <TouchableOpacity
              key={mode}
              style={[s.toggleBtn, viewMode === mode && { backgroundColor: colors.primary }]}
              onPress={() => setViewMode(mode)}
            >
              <Text style={[s.toggleText, { color: viewMode === mode ? colors.textInverse : colors.textSecondary }]}>
                {mode === 'week' ? 'Week' : 'Month'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {viewMode === 'week' ? (
        <>
          {/* ── Week navigation ── */}
          <View style={[s.navRow, { borderBottomColor: colors.border }]}>
            <TouchableOpacity
              onPress={() => setWeekStart((d) => shiftDays(d, -7))}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="chevron-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[s.navLabel, { color: colors.text }]}>{formatWeekRange(weekStart)}</Text>
            <TouchableOpacity
              onPress={() => setWeekStart((d) => shiftDays(d, 7))}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="chevron-forward" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* ── Horizontal day carousel ── */}
          <FlatList
            ref={carouselRef}
            horizontal
            data={weekDays}
            keyExtractor={(item) => toISO(item)}
            showsHorizontalScrollIndicator={false}
            snapToInterval={CARD_WIDTH + CARD_GAP}
            decelerationRate="fast"
            contentContainerStyle={[
              s.carouselContent,
              { paddingHorizontal: CARD_SIDE_PAD },
            ]}
            getItemLayout={(_, index) => ({
              length: CARD_WIDTH + CARD_GAP,
              offset: CARD_SIDE_PAD + index * (CARD_WIDTH + CARD_GAP),
              index,
            })}
            onLayout={scrollCarouselToToday}
            renderItem={({ item: day }) => {
              const dateStr = toISO(day);
              const dayEntries = forDate(dateStr);
              const isToday = dateStr === today;

              // Sum macros for this day from loaded recipes
              const dayMacros = dayEntries.reduce(
                (acc, e) => {
                  const r = recipes[e.recipeId];
                  if (!r) return acc;
                  return {
                    calories: acc.calories + r.nutrition.calories,
                    protein: acc.protein + r.nutrition.protein,
                    carbs: acc.carbs + r.nutrition.carbs,
                    fat: acc.fat + r.nutrition.fat,
                  };
                },
                { calories: 0, protein: 0, carbs: 0, fat: 0 }
              );
              const hasMacros = dayEntries.some((e) => recipes[e.recipeId]);
              // First loaded recipe — used when tapping the card outside a meal row
              const firstEntry = dayEntries.find((e) => recipes[e.recipeId]);
              const firstRecipe = firstEntry ? recipes[firstEntry.recipeId] : null;

              return (
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => {
                    if (!firstRecipe || !firstEntry) return;
                    setPreviewRecipe(firstRecipe);
                    setPreviewEntry({
                      id: firstEntry.id!,
                      adults: firstEntry.adults,
                      children: firstEntry.children,
                      servings: firstEntry.servings,
                    });
                  }}
                  style={[
                    s.dayCard,
                    { backgroundColor: colors.surface, width: CARD_WIDTH, marginRight: CARD_GAP },
                    isToday && { borderWidth: 2, borderColor: colors.primary },
                    Shadows.sm,
                  ]}
                >
                  {/* Card header */}
                  <View style={s.dayCardHeader}>
                    <View>
                      <Text style={[s.dayCardWeekday, { color: isToday ? colors.primary : colors.textSecondary }]}>
                        {day.toLocaleDateString('en-AU', { weekday: 'long' })}
                      </Text>
                      <Text style={[s.dayCardDate, { color: colors.text }]}>
                        {day.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                      </Text>
                    </View>
                    {isToday && (
                      <View style={[s.todayPill, { backgroundColor: colors.primary }]}>
                        <Text style={[s.todayPillText, { color: colors.textInverse }]}>Today</Text>
                      </View>
                    )}
                  </View>

                  {/* Meals */}
                  {dayEntries.length === 0 ? (
                    <View style={s.cardEmptyWrap}>
                      <Ionicons name="restaurant-outline" size={28} color={colors.textTertiary} />
                      <Text style={[s.cardEmptyText, { color: colors.textTertiary }]}>No meals planned</Text>
                    </View>
                  ) : (
                    <View style={s.cardMeals}>
                      {dayEntries.map((entry) => {
                        const recipe = recipes[entry.recipeId];
                        const presentation = getRecipePresentation(recipe, missingRecipeIds.has(entry.recipeId));
                        const { bg, fg } = mealBadge(entry.mealType, colors);
                        return (
                          <TouchableOpacity
                            key={entry.id}
                            style={[s.cardMealRow, { backgroundColor: colors.background }]}
                            onPress={() => {
                              if (!recipe) return;
                              setPreviewRecipe(recipe);
                              setPreviewEntry({
                                id: entry.id!,
                                adults: entry.adults,
                                children: entry.children,
                                servings: entry.servings,
                              });
                            }}
                            onLongPress={() => handleDelete(entry)}
                            disabled={presentation.status === 'loading'}
                            activeOpacity={0.7}
                          >
                            <View style={[s.mealBadge, { backgroundColor: bg }]}>
                              <Text style={[s.mealBadgeText, { color: fg }]}>
                                {MEAL_LABELS[entry.mealType]}
                              </Text>
                            </View>
                            {presentation.status === 'unavailable' && (
                              <Ionicons name="alert-circle-outline" size={18} color={colors.textTertiary} />
                            )}
                            <View style={s.cardMealInfo}>
                              <Text
                                style={[
                                  s.cardMealTitle,
                                  { color: presentation.status === 'unavailable' ? colors.textTertiary : colors.text },
                                ]}
                                numberOfLines={2}
                              >
                                {presentation.title}
                              </Text>
                              {recipe && (
                                <View style={s.cardMealMetaRow}>
                                  <Text style={[s.cardMealMeta, { color: colors.textTertiary }]}>
                                    {recipe.prepTime} prep · {recipe.cookTime} cook
                                  </Text>
                                  {(recipe.needsDefrost || recipe.needsMarinate) && (
                                    <View style={s.reminderChips}>
                                      {recipe.needsDefrost && (
                                        <View style={[s.reminderChip, { backgroundColor: colors.carbsBadge }]}>
                                          <Ionicons name="snow-outline" size={10} color={colors.carbsText} />
                                        </View>
                                      )}
                                      {recipe.needsMarinate && (
                                        <View style={[s.reminderChip, { backgroundColor: colors.accentLight }]}>
                                          <Ionicons name="timer-outline" size={10} color={colors.accent} />
                                        </View>
                                      )}
                                    </View>
                                  )}
                                </View>
                              )}
                            </View>
                            {recipe?.imageUrl && (
                              <Image
                                source={{ uri: recipe.imageUrl }}
                                style={s.mealRowThumb}
                              />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}

                  {/* Macro strip */}
                  {hasMacros && (
                    <View style={[s.cardMacroStrip, { borderTopColor: colors.borderLight }]}>
                      <CardMacro value={String(Math.round(dayMacros.calories))} label="kcal" fg={colors.caloriesText} bg={colors.caloriesBadge} />
                      <CardMacro value={`${Math.round(dayMacros.protein)}g`} label="protein" fg={colors.proteinText} bg={colors.proteinBadge} />
                      <CardMacro value={`${Math.round(dayMacros.carbs)}g`} label="carbs" fg={colors.carbsText} bg={colors.carbsBadge} />
                      <CardMacro value={`${Math.round(dayMacros.fat)}g`} label="fat" fg={colors.fatText} bg={colors.fatBadge} />
                    </View>
                  )}
                </TouchableOpacity>
              );
            }}
          />
        </>
      ) : (
        <>
          {/* ── Month navigation ── */}
          <View style={[s.navRow, { borderBottomColor: colors.border }]}>
            <TouchableOpacity
              onPress={() =>
                setMonthYear(({ year, month }) =>
                  month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }
                )
              }
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="chevron-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[s.navLabel, { color: colors.text }]}>
              {formatMonthYear(monthYear.year, monthYear.month)}
            </Text>
            <TouchableOpacity
              onPress={() =>
                setMonthYear(({ year, month }) =>
                  month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }
                )
              }
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="chevron-forward" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.monthScroll} showsVerticalScrollIndicator={false}>
            {/* Day-of-week header */}
            <View style={s.dowRow}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <Text key={d} style={[s.dowLabel, { color: colors.textTertiary }]}>{d}</Text>
              ))}
            </View>

            {monthGrid.map((row, ri) => (
              <View key={ri} style={s.gridRow}>
                {row.map((day, ci) => {
                  if (!day) return <View key={ci} style={s.gridCell} />;
                  const dateStr = toISO(day);
                  const dayEntries = forDate(dateStr);
                  const isToday = dateStr === today;
                  const shown = dayEntries.slice(0, 2);
                  const overflow = dayEntries.length - shown.length;

                  return (
                    <TouchableOpacity
                      key={ci}
                      style={[
                        s.gridCell,
                        isToday && {
                          backgroundColor: colors.primaryLight,
                          borderRadius: Radius.sm,
                        },
                      ]}
                      onPress={() => {
                        const dow = (day.getDay() + 6) % 7;
                        const mon = new Date(day);
                        mon.setDate(day.getDate() - dow);
                        mon.setHours(0, 0, 0, 0);
                        setWeekStart(mon);
                        setViewMode('week');
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.gridDayNum, { color: isToday ? colors.primary : colors.text }]}>
                        {day.getDate()}
                      </Text>
                      {shown.map((entry, idx) => {
                        const recipe = recipes[entry.recipeId];
                        const presentation = getRecipePresentation(recipe, missingRecipeIds.has(entry.recipeId));
                        const { bg, fg } = mealBadge(entry.mealType, colors);
                        return (
                          <View key={idx} style={[s.gridMealPill, { backgroundColor: bg }]}>
                            <Text style={[s.gridMealText, { color: fg }]} numberOfLines={1}>
                              {abbreviateTitle(presentation.title)}
                            </Text>
                          </View>
                        );
                      })}
                      {overflow > 0 && (
                        <Text style={[s.gridOverflow, { color: colors.textTertiary }]}>
                          +{overflow}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}

            {entries.length === 0 && (
              <View style={s.emptyWrap}>
                <Ionicons name="calendar-outline" size={52} color={colors.textTertiary} />
                <Text style={[s.emptyTitle, { color: colors.text }]}>No meals planned yet</Text>
                <Text style={[s.emptyHint, { color: colors.textSecondary }]}>
                  Use the Generate tab to create your first meal plan
                </Text>
              </View>
            )}
          </ScrollView>
        </>
      )}

      <RecipeDetailModal
        recipe={previewRecipe}
        visible={!!previewRecipe}
        onClose={() => { setPreviewRecipe(null); setPreviewEntry(null); }}
        mealPlanEntry={previewEntry ?? undefined}
        starred={previewRecipe ? (cookbook.find((e) => e.recipeId === previewRecipe.id)?.starred ?? false) : undefined}
        onStarToggle={() => {
          if (!householdId || !previewRecipe?.id) return;
          const current = cookbook.find((e) => e.recipeId === previewRecipe.id)?.starred ?? false;
          toggleStarred(householdId, previewRecipe.id, !current)
            .catch((err) => console.warn('[index] star toggle failed:', err));
        }}
        onCourseUpdate={(id, course) => {
          setPreviewRecipe((prev) => prev?.id === id ? { ...prev, course } : prev);
          setRecipes((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], course } } : prev);
        }}
      />
    </SafeAreaView>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function CardMacro({ value, label, fg, bg }: { value: string; label: string; fg: string; bg: string }) {
  return (
    <View style={[s.cardMacro, { backgroundColor: bg }]}>
      <Text style={[s.cardMacroValue, { color: fg }]}>{value}</Text>
      <Text style={[s.cardMacroLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Header
  screenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  screenTitle: { fontSize: FontSizes.xxl, fontFamily: Fonts.bold },

  // Week/Month toggle
  toggle: {
    flexDirection: 'row',
    borderRadius: Radius.pill,
    padding: 2,
  },
  toggleBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
  },
  toggleText: { fontSize: FontSizes.sm, fontFamily: Fonts.medium },

  // Navigation row
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  navLabel: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },

  // ── Weekly carousel ──
  carouselContent: {
    paddingVertical: Spacing.xl,
    alignItems: 'flex-start',
  },

  // Day card
  dayCard: {
    borderRadius: Radius.xxl,
    overflow: 'hidden',
  },
  dayCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.md,
  },
  dayCardWeekday: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  dayCardDate: {
    fontSize: FontSizes.xl,
    fontFamily: Fonts.bold,
    marginTop: 2,
  },
  todayPill: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  todayPillText: {
    color: '#fff',
    fontSize: FontSizes.xs,
    fontFamily: Fonts.bold,
  },

  // Card empty state
  cardEmptyWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.massive,
    gap: Spacing.sm,
  },
  cardEmptyText: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.regular,
  },

  // Card meals
  cardMeals: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.xs,
    paddingBottom: Spacing.md,
  },
  cardMealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: Radius.xl,
  },
  cardMealInfo: { flex: 1 },
  cardMealTitle: { fontSize: FontSizes.md, fontFamily: Fonts.semibold, lineHeight: 20 },
  cardMealMetaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginTop: 2 },
  cardMealMeta: { fontSize: FontSizes.xs, fontFamily: Fonts.regular },
  reminderChips: { flexDirection: 'row', gap: 4 },
  reminderChip: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  mealRowThumb: { width: 44, height: 44, borderRadius: Radius.md, flexShrink: 0 },

  mealBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
    borderRadius: Radius.pill,
    flexShrink: 0,
  },
  mealBadgeText: { fontSize: FontSizes.xs, fontFamily: Fonts.semibold },

  // Card macro strip
  cardMacroStrip: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
  },
  cardMacro: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.xs,
    borderRadius: Radius.md,
    gap: 1,
  },
  cardMacroValue: { fontSize: FontSizes.xs, fontFamily: Fonts.bold },
  cardMacroLabel: { fontSize: 9, fontFamily: Fonts.regular },

  // ── Month view ──
  monthScroll: { padding: Spacing.lg, paddingBottom: Spacing.massive },

  dowRow: { flexDirection: 'row', marginBottom: Spacing.sm },
  dowLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: FontSizes.xs,
    fontFamily: Fonts.medium,
  },

  gridRow: { flexDirection: 'row', marginBottom: 4 },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.xs,
    paddingHorizontal: 2,
    minHeight: 92,
  },
  gridDayNum: { fontSize: FontSizes.sm, fontFamily: Fonts.medium, marginBottom: 3 },

  gridMealPill: {
    borderRadius: Radius.sm,
    paddingHorizontal: 3,
    paddingVertical: 1,
    marginBottom: 2,
    maxWidth: '100%',
  },
  gridMealText: {
    fontSize: 8,
    fontFamily: Fonts.semibold,
  },
  gridOverflow: {
    fontSize: 8,
    fontFamily: Fonts.medium,
    marginTop: 1,
  },

  // ── Empty state ──
  emptyWrap: {
    alignItems: 'center',
    paddingTop: Spacing.massive,
    gap: Spacing.md,
  },
  emptyTitle: { fontSize: FontSizes.xl, fontFamily: Fonts.bold },
  emptyHint: { fontSize: FontSizes.md, fontFamily: Fonts.regular, textAlign: 'center', lineHeight: 22 },
});
