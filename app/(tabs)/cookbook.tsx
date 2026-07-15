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
import {
  getRecipePresentation,
  reconcileRecipeAvailability,
} from '@/services/recipeAvailability';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GRID_PADDING = Spacing.xl;
const GRID_GAP = Spacing.md;
const GRID_CARD_WIDTH = (SCREEN_WIDTH - GRID_PADDING * 2 - GRID_GAP) / 2;

// ─── Screen ───────────────────────────────────────────────────

type ViewMode = 'grid' | 'list';

export default function CookbookScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { householdId } = useAuth();

  const [entries, setEntries] = useState<CookbookEntry[]>([]);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const [missingRecipeIds, setMissingRecipeIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);
  const [loading, setLoading] = useState(true);

  const loadedIdsRef = useRef<Set<string>>(new Set());

  // ── Real-time subscription ──
  useEffect(() => {
    if (!householdId) return;
    return subscribeCookbook(householdId, (e) => {
      setEntries(e);
      setLoading(false);
    });
  }, [householdId]);

  // ── Lazy recipe loading ──
  useEffect(() => {
    const toLoad = entries
      .map((e) => e.recipeId)
      .filter((id) => !loadedIdsRef.current.has(id));
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
    (entry: CookbookEntry) => {
      if (!householdId) return;
      toggleStarred(householdId, entry.recipeId, !entry.starred);
    },
    [householdId]
  );

  const handleRemove = useCallback(
    (entry: CookbookEntry) => {
      if (!householdId) return;
      const title = recipes[entry.recipeId]?.title ?? 'this recipe';
      Alert.alert('Remove recipe', `Remove "${title}" from your cookbook?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeFromCookbook(householdId, entry.recipeId),
        },
      ]);
    },
    [householdId, recipes]
  );

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
                colors={colors}
                onPress={() => recipe && setPreviewRecipe(recipe)}
                onStar={() => handleStarToggle(entry)}
                onRemove={() => handleRemove(entry)}
              />
            ) : (
              <ListRow
                entry={entry}
                recipe={recipe}
                missing={missingRecipeIds.has(entry.recipeId)}
                colors={colors}
                onPress={() => recipe && setPreviewRecipe(recipe)}
                onStar={() => handleStarToggle(entry)}
                onRemove={() => handleRemove(entry)}
              />
            );
          }}
        />
      )}

      <RecipeDetailModal
        recipe={previewRecipe}
        visible={!!previewRecipe}
        onClose={() => setPreviewRecipe(null)}
        defaultServings={previewRecipe?.originalServings}
        starred={previewRecipe ? (entries.find((e) => e.recipeId === previewRecipe.id)?.starred ?? false) : undefined}
        onStarToggle={() => {
          if (!previewRecipe) return;
          const entry = entries.find((e) => e.recipeId === previewRecipe.id);
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
  colors,
  onPress,
  onStar,
  onRemove,
}: {
  entry: CookbookEntry;
  recipe: Recipe | undefined;
  missing: boolean;
  colors: (typeof Colors)['light'];
  onPress: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  const presentation = getRecipePresentation(recipe, missing);
  const initials = recipe?.title
    ? recipe.title
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
    : '…';

  return (
    <TouchableOpacity
      style={[s.gridCard, { backgroundColor: colors.surface, width: GRID_CARD_WIDTH }, Shadows.sm]}
      onPress={onPress}
      disabled={presentation.status === 'loading'}
      activeOpacity={0.8}
    >
      {/* Top-half image (falls back to initials when no imageUrl) */}
      {recipe?.imageUrl ? (
        <Image source={{ uri: recipe.imageUrl }} style={s.cardImage} resizeMode="cover" />
      ) : (
        <View style={[s.cardImage, s.cardImageFallback, { backgroundColor: colors.primaryLight }]}>
          {recipe ? (
            <Text style={[s.avatarText, { color: colors.primary }]}>{initials}</Text>
          ) : missing ? (
            <Ionicons name="alert-circle-outline" size={24} color={colors.textTertiary} />
          ) : (
            <ActivityIndicator size="small" color={colors.primary} />
          )}
        </View>
      )}

      <View style={s.cardBody}>
        <View style={s.cardTitleRow}>
          <Text
            style={[
              s.cardTitle,
              s.cardTitleFlex,
              { color: missing ? colors.textTertiary : colors.text },
            ]}
            numberOfLines={2}
          >
            {presentation.title}
          </Text>
          <View style={s.cardActions}>
            <TouchableOpacity
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
              onPress={onRemove}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="trash-outline" size={17} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        </View>
        {recipe && (
          <Text style={[s.cardMeta, { color: colors.textTertiary }]}>
            {recipe.prepTime} · {recipe.cookTime}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── List Row ─────────────────────────────────────────────────

function ListRow({
  entry,
  recipe,
  missing,
  colors,
  onPress,
  onStar,
  onRemove,
}: {
  entry: CookbookEntry;
  recipe: Recipe | undefined;
  missing: boolean;
  colors: (typeof Colors)['light'];
  onPress: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  const presentation = getRecipePresentation(recipe, missing);
  const initial = recipe?.title?.[0]?.toUpperCase() ?? '…';

  return (
    <TouchableOpacity
      style={[s.listRow, { backgroundColor: colors.surface }, Shadows.sm]}
      onPress={onPress}
      disabled={presentation.status === 'loading'}
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
          ) : (
            <ActivityIndicator size="small" color={colors.primary} />
          )}
        </View>
      )}

      <View style={s.listInfo}>
        <Text
          style={[s.cardTitle, { color: missing ? colors.textTertiary : colors.text }]}
          numberOfLines={1}
        >
          {presentation.title}
        </Text>
        {recipe && (
          <Text style={[s.cardMeta, { color: colors.textTertiary }]}>
            {recipe.prepTime} prep · {recipe.cookTime} cook · {recipe.nutrition.calories} kcal
          </Text>
        )}
      </View>

      <View style={s.cardActions}>
        <TouchableOpacity
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
          onPress={onRemove}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="trash-outline" size={19} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
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
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  cardTitle: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold, lineHeight: 18 },
  cardTitleFlex: { flex: 1 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
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
