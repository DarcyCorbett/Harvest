// ============================================================
// Meal Wizard — Cookbook Tab (Phase 7)
// Personal recipe collection: real-time subscription, lazy
// recipe loading, grid/list toggle, search, star toggle, and
// favourites filter.
// ============================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSizes, Fonts, Spacing, Radius, Shadows } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import {
  subscribeCookbook,
  toggleStarred,
  getRecipe,
  removeFromCookbook,
} from '@/services/firestoreService';
import RecipeDetailModal from '@/components/RecipeDetailModal';
import type { CookbookEntry, Recipe } from '@/services/types';
import { hasMeaningfulNutrition } from '@/services/recipePresentation';
import {
  applyRecipeFetchResults,
  beginRecipeLoads,
  createRecipeHistoryState,
  executeOwnedHistoryAction,
  getRecipePresentation,
  isCurrentHistorySession,
  pruneRecipeHistory,
  recipeIdsToLoad,
  retryRecipeLoad,
  type HistoryOwnershipToken,
} from '@/services/recipeAvailability';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GRID_PADDING = Spacing.xl;
const GRID_GAP = Spacing.md;
const GRID_CARD_WIDTH = (SCREEN_WIDTH - GRID_PADDING * 2 - GRID_GAP) / 2;
const EMPTY_COOKBOOK_ENTRIES: CookbookEntry[] = [];
const EMPTY_RECIPES: Record<string, Recipe> = {};
const EMPTY_RECIPE_IDS = new Set<string>();

// ─── Screen ───────────────────────────────────────────────────

type ViewMode = 'grid' | 'list';

export default function CookbookScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { householdId } = useAuth();

  const [snapshotEntries, setSnapshotEntries] = useState<CookbookEntry[]>([]);
  const [snapshotOwnership, setSnapshotOwnership] = useState<HistoryOwnershipToken | null>(null);
  const [recipeHistory, setRecipeHistory] = useState(() =>
    createRecipeHistoryState<Recipe>(null, 0)
  );
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);
  const [loading, setLoading] = useState(true);

  const sessionGenerationRef = useRef(0);
  const snapshotRevisionRef = useRef(0);
  const currentHouseholdRef = useRef<string | null>(householdId);
  currentHouseholdRef.current = householdId;
  const ownsSnapshot = !!householdId
    && snapshotOwnership?.householdId === householdId
    && snapshotOwnership.generation === sessionGenerationRef.current
    && snapshotOwnership.snapshotRevision === snapshotRevisionRef.current;
  const entries = ownsSnapshot ? snapshotEntries : EMPTY_COOKBOOK_ENTRIES;
  const ownsRecipeHistory = ownsSnapshot && recipeHistory.householdId === householdId;
  const recipes = ownsRecipeHistory ? recipeHistory.recipes : EMPTY_RECIPES;
  const missingRecipeIds = ownsRecipeHistory ? recipeHistory.missingRecipeIds : EMPTY_RECIPE_IDS;
  const errorRecipeIds = ownsRecipeHistory ? recipeHistory.errorRecipeIds : EMPTY_RECIPE_IDS;
  const visiblePreviewRecipe = ownsSnapshot ? previewRecipe : null;

  // ── Real-time subscription ──
  useEffect(() => {
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    currentHouseholdRef.current = householdId;
    setSnapshotEntries([]);
    setSnapshotOwnership(null);
    setPreviewRecipe(null);
    setLoading(!!householdId);
    setRecipeHistory(createRecipeHistoryState<Recipe>(householdId, generation));
    if (!householdId) return;

    return subscribeCookbook(householdId, (nextEntries) => {
      if (!isCurrentHistorySession(
        householdId,
        generation,
        currentHouseholdRef.current,
        sessionGenerationRef.current,
      )) return;
      const snapshotRevision = snapshotRevisionRef.current + 1;
      snapshotRevisionRef.current = snapshotRevision;
      setSnapshotEntries(nextEntries);
      setSnapshotOwnership({ householdId, generation, snapshotRevision });
      setRecipeHistory((previous) =>
        pruneRecipeHistory(previous, nextEntries.map((entry) => entry.recipeId))
      );
      setLoading(false);
    });
  }, [householdId]);

  // ── Lazy recipe loading ──
  useEffect(() => {
    if (!householdId || !ownsSnapshot || recipeHistory.householdId !== householdId) return;
    const toLoad = recipeIdsToLoad(entries.map((entry) => entry.recipeId), recipeHistory);
    if (!toLoad.length) return;
    const loadingHistory = beginRecipeLoads(recipeHistory, toLoad);
    const request = {
      householdId,
      generation: recipeHistory.generation,
      recipeIds: toLoad,
      loadTokens: Object.fromEntries(
        toLoad.map((recipeId) => [recipeId, loadingHistory.activeLoadTokens[recipeId]])
      ),
    };
    setRecipeHistory(loadingHistory);
    Promise.allSettled(toLoad.map(getRecipe)).then((results) => {
      if (!isCurrentHistorySession(
        request.householdId,
        request.generation,
        currentHouseholdRef.current,
        sessionGenerationRef.current,
      )) return;
      setRecipeHistory((previous) => applyRecipeFetchResults(previous, request, results));
    });
  }, [entries, householdId, ownsSnapshot, recipeHistory]);

  const getCurrentOwnership = useCallback((): HistoryOwnershipToken | null => {
    const currentHouseholdId = currentHouseholdRef.current;
    if (!currentHouseholdId) return null;
    return {
      householdId: currentHouseholdId,
      generation: sessionGenerationRef.current,
      snapshotRevision: snapshotRevisionRef.current,
    };
  }, []);

  // ── Filtered + sorted list ──
  const filtered = useMemo(() => {
    let result = entries;
    if (onlyStarred) result = result.filter((e) => e.starred);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter((e) => recipes[e.recipeId]?.title.toLowerCase().includes(q));
    }
    return [...result].sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
  }, [entries, recipes, onlyStarred, search]);

  const handleStarToggle = useCallback(
    async (entry: CookbookEntry) => {
      const result = await executeOwnedHistoryAction(
        snapshotOwnership,
        getCurrentOwnership(),
        (ownerHouseholdId) => toggleStarred(ownerHouseholdId, entry.recipeId, !entry.starred),
        () => Alert.alert('Could not update favourite', 'Please try again.'),
      );
      if (result === 'blocked') {
        Alert.alert('Household changed', 'Wait for the current cookbook to finish loading.');
      }
    },
    [getCurrentOwnership, snapshotOwnership]
  );

  const handleRemove = useCallback(
    (entry: CookbookEntry) => {
      const title = recipes[entry.recipeId]?.title ?? 'this recipe';
      Alert.alert('Remove recipe', `Remove "${title}" from your cookbook?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const result = await executeOwnedHistoryAction(
              snapshotOwnership,
              getCurrentOwnership(),
              (ownerHouseholdId) => removeFromCookbook(ownerHouseholdId, entry.recipeId),
              () => Alert.alert('Could not remove recipe', 'Please try again.'),
            );
            if (result === 'blocked') {
              Alert.alert('Household changed', 'Wait for the current cookbook to finish loading.');
            }
          },
        },
      ]);
    },
    [getCurrentOwnership, recipes, snapshotOwnership]
  );

  if (loading || (!!householdId && !ownsSnapshot)) {
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
      {/* ── Header ── */}
      <View style={s.header}>
        <Text style={[s.title, { color: colors.text }]}>Cookbook</Text>
        <View style={s.headerActions}>
          <TouchableOpacity
            onPress={() => {
              setShowSearch((v) => !v);
              if (showSearch) setSearch('');
            }}
            style={[s.iconBtn, { backgroundColor: colors.surface }, Shadows.sm]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={showSearch ? 'close' : 'search-outline'}
              size={20}
              color={colors.textSecondary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setViewMode((v) => (v === 'grid' ? 'list' : 'grid'))}
            style={[s.iconBtn, { backgroundColor: colors.surface }, Shadows.sm]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={viewMode === 'grid' ? 'list-outline' : 'grid-outline'}
              size={20}
              color={colors.textSecondary}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Search bar ── */}
      {showSearch && (
        <View style={s.searchRow}>
          <View style={[s.searchBar, { backgroundColor: colors.inputBackground }]}>
            <Ionicons name="search-outline" size={16} color={colors.textTertiary} />
            <TextInput
              style={[s.searchInput, { color: colors.text }]}
              value={search}
              onChangeText={setSearch}
              placeholder="Search recipes…"
              placeholderTextColor={colors.textTertiary}
              autoFocus
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')}>
                <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* ── Filter row ── */}
      <View style={[s.filterRow, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[
            s.filterChip,
            { borderColor: onlyStarred ? colors.primary : colors.border },
            onlyStarred && { backgroundColor: colors.primaryLight },
          ]}
          onPress={() => setOnlyStarred((v) => !v)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={onlyStarred ? 'star' : 'star-outline'}
            size={13}
            color={onlyStarred ? colors.primary : colors.textSecondary}
          />
          <Text
            style={[
              s.filterChipText,
              { color: onlyStarred ? colors.primary : colors.textSecondary },
            ]}
          >
            Favourites
          </Text>
        </TouchableOpacity>

        <Text style={[s.countLabel, { color: colors.textTertiary }]}>
          {filtered.length} recipe{filtered.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* ── Content ── */}
      {filtered.length === 0 ? (
        <View style={s.emptyWrap}>
          <Ionicons name="book-outline" size={52} color={colors.textTertiary} />
          <Text style={[s.emptyTitle, { color: colors.text }]}>
            {entries.length === 0 ? 'Your cookbook is empty' : 'No recipes found'}
          </Text>
          <Text style={[s.emptyHint, { color: colors.textSecondary }]}>
            {entries.length === 0
              ? 'Every recipe from your meal plans will be saved here automatically.'
              : 'Try a different search or remove the filter.'}
          </Text>
        </View>
      ) : (
        <FlatList
          key={viewMode}
          data={filtered}
          numColumns={viewMode === 'grid' ? 2 : 1}
          keyExtractor={(item) => item.recipeId}
          contentContainerStyle={
            viewMode === 'grid' ? s.gridContent : s.listContent
          }
          columnWrapperStyle={viewMode === 'grid' ? s.gridRow : undefined}
          showsVerticalScrollIndicator={false}
          renderItem={({ item: entry }) => {
            const recipe = recipes[entry.recipeId];
            return viewMode === 'grid' ? (
              <GridCard
                entry={entry}
                recipe={recipe}
                missing={missingRecipeIds.has(entry.recipeId)}
                error={errorRecipeIds.has(entry.recipeId)}
                colors={colors}
                onPress={() => {
                  if (errorRecipeIds.has(entry.recipeId)) {
                    setRecipeHistory((previous) => retryRecipeLoad(previous, entry.recipeId));
                  } else if (recipe) setPreviewRecipe(recipe);
                }}
                onStar={() => handleStarToggle(entry)}
                onRemove={() => handleRemove(entry)}
              />
            ) : (
              <ListRow
                entry={entry}
                recipe={recipe}
                missing={missingRecipeIds.has(entry.recipeId)}
                error={errorRecipeIds.has(entry.recipeId)}
                colors={colors}
                onPress={() => {
                  if (errorRecipeIds.has(entry.recipeId)) {
                    setRecipeHistory((previous) => retryRecipeLoad(previous, entry.recipeId));
                  } else if (recipe) setPreviewRecipe(recipe);
                }}
                onStar={() => handleStarToggle(entry)}
                onRemove={() => handleRemove(entry)}
              />
            );
          }}
        />
      )}

      <RecipeDetailModal
        recipe={visiblePreviewRecipe}
        visible={!!visiblePreviewRecipe}
        onClose={() => setPreviewRecipe(null)}
        defaultServings={visiblePreviewRecipe?.originalServings}
        starred={visiblePreviewRecipe ? (entries.find((e) => e.recipeId === visiblePreviewRecipe.id)?.starred ?? false) : undefined}
        onStarToggle={() => {
          if (!visiblePreviewRecipe) return;
          const entry = entries.find((e) => e.recipeId === visiblePreviewRecipe.id);
          if (entry) handleStarToggle(entry);
        }}
        onCourseUpdate={(id, course) =>
          setPreviewRecipe((prev) => prev?.id === id ? { ...prev, course } : prev)
        }
        onTagsUpdate={(id, tags) =>
          setPreviewRecipe((prev) => prev?.id === id ? { ...prev, tags } : prev)
        }
      />
    </SafeAreaView>
  );
}

// ─── Grid Card ────────────────────────────────────────────────

function GridCard({
  entry,
  recipe,
  missing,
  error,
  colors,
  onPress,
  onStar,
  onRemove,
}: {
  entry: CookbookEntry;
  recipe: Recipe | undefined;
  missing: boolean;
  error: boolean;
  colors: (typeof Colors)['light'];
  onPress: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  const presentation = getRecipePresentation(recipe, missing, error);
  const initials = recipe?.title
    ? recipe.title
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
    : '…';

  return (
    <View
      style={[s.gridCard, { backgroundColor: colors.surface, width: GRID_CARD_WIDTH }, Shadows.sm]}
    >
      <TouchableOpacity
        onPress={onPress}
        disabled={presentation.status === 'loading' || presentation.status === 'unavailable'}
        activeOpacity={0.8}
      >
        {recipe?.imageUrl ? (
          <Image source={{ uri: recipe.imageUrl }} style={s.cardImage} resizeMode="cover" />
        ) : (
          <View style={[s.cardImage, s.cardImageFallback, { backgroundColor: colors.primaryLight }]}>
            {recipe ? (
              <Text style={[s.avatarText, { color: colors.primary }]}>{initials}</Text>
            ) : missing ? (
              <Ionicons name="alert-circle-outline" size={24} color={colors.textTertiary} />
            ) : error ? (
              <Ionicons name="refresh-circle-outline" size={24} color={colors.error} />
            ) : (
              <ActivityIndicator size="small" color={colors.primary} />
            )}
          </View>
        )}

        <View style={s.cardBody}>
          <Text
            style={[
              s.cardTitle,
              { color: presentation.status === 'available' ? colors.text : colors.textTertiary },
            ]}
            numberOfLines={2}
          >
            {presentation.title}
          </Text>
          {recipe && (
            <Text style={[s.cardMeta, { color: colors.textTertiary }]}>
              {recipe.prepTime} · {recipe.cookTime}
            </Text>
          )}
        </View>
      </TouchableOpacity>
      <View style={[s.cardActions, s.cardActionFooter]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={entry.starred ? 'Remove from favourites' : 'Add to favourites'}
          onPress={onStar}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name={entry.starred ? 'star' : 'star-outline'}
            size={18}
            color={entry.starred ? colors.warning : colors.textTertiary}
          />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Remove from cookbook"
          onPress={onRemove}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={17} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── List Row ─────────────────────────────────────────────────

function ListRow({
  entry,
  recipe,
  missing,
  error,
  colors,
  onPress,
  onStar,
  onRemove,
}: {
  entry: CookbookEntry;
  recipe: Recipe | undefined;
  missing: boolean;
  error: boolean;
  colors: (typeof Colors)['light'];
  onPress: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  const presentation = getRecipePresentation(recipe, missing, error);
  const initial = recipe?.title?.[0]?.toUpperCase() ?? '…';

  return (
    <View style={[s.listRow, { backgroundColor: colors.surface }, Shadows.sm]}>
      <TouchableOpacity
        style={s.listPreview}
        onPress={onPress}
        disabled={presentation.status === 'loading' || presentation.status === 'unavailable'}
        activeOpacity={0.8}
      >
        {recipe?.imageUrl ? (
          <Image source={{ uri: recipe.imageUrl }} style={s.listAvatar} resizeMode="cover" />
        ) : (
          <View style={[s.listAvatar, s.listAvatarFallback, { backgroundColor: colors.primaryLight }]}>
            {recipe ? (
              <Text style={[s.listAvatarText, { color: colors.primary }]}>{initial}</Text>
            ) : missing ? (
              <Ionicons name="alert-circle-outline" size={22} color={colors.textTertiary} />
            ) : error ? (
              <Ionicons name="refresh-circle-outline" size={22} color={colors.error} />
            ) : (
              <ActivityIndicator size="small" color={colors.primary} />
            )}
          </View>
        )}
        <View style={s.listInfo}>
          <Text
            style={[s.cardTitle, { color: presentation.status === 'available' ? colors.text : colors.textTertiary }]}
            numberOfLines={1}
          >
            {presentation.title}
          </Text>
          {recipe && (
            <Text style={[s.cardMeta, { color: colors.textTertiary }]}>
              {recipe.prepTime} prep · {recipe.cookTime} cook · {hasMeaningfulNutrition(recipe.nutrition) && recipe.nutrition.calories !== undefined
                ? `${recipe.nutrition.calories} kcal`
                : 'Nutrition unavailable'}
            </Text>
          )}
        </View>
      </TouchableOpacity>
      <View style={s.cardActions}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={entry.starred ? 'Remove from favourites' : 'Add to favourites'}
          onPress={onStar}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons
            name={entry.starred ? 'star' : 'star-outline'}
            size={20}
            color={entry.starred ? colors.warning : colors.textTertiary}
          />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Remove from cookbook"
          onPress={onRemove}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="trash-outline" size={19} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  title: { fontSize: FontSizes.xxl, fontFamily: Fonts.bold },
  headerActions: { flexDirection: 'row', gap: Spacing.sm },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Search
  searchRow: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.sm,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.xl,
  },
  searchInput: { flex: 1, fontSize: FontSizes.md, paddingVertical: 0 },

  // Filter row
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  filterChipText: { fontSize: FontSizes.sm, fontFamily: Fonts.medium },
  countLabel: { fontSize: FontSizes.sm },

  // Grid
  gridContent: {
    padding: GRID_PADDING,
    paddingBottom: Spacing.massive,
  },
  gridRow: { gap: GRID_GAP, marginBottom: GRID_GAP },
  gridCard: {
    borderRadius: Radius.xl,
    overflow: 'hidden',
  },
  cardImage: {
    width: '100%',
    aspectRatio: 1,
  },
  cardImageFallback: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: FontSizes.xxl,
    fontFamily: Fonts.bold,
  },
  cardBody: { padding: Spacing.md, flex: 1 },
  cardTitle: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold, lineHeight: 18 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  cardActionFooter: {
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
  },
  cardMeta: { fontSize: FontSizes.xs, marginTop: Spacing.xs },

  // List
  listContent: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.massive,
    gap: Spacing.sm,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.xl,
  },
  listPreview: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  listAvatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.lg,
    flexShrink: 0,
    overflow: 'hidden',
  },
  listAvatarFallback: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  listAvatarText: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.bold,
  },
  listInfo: { flex: 1 },

  // Empty state
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.md,
  },
  emptyTitle: { fontSize: FontSizes.xl, fontFamily: Fonts.bold },
  emptyHint: { fontSize: FontSizes.md, textAlign: 'center', lineHeight: 22 },
});
