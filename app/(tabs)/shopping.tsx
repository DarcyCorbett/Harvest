// ============================================================
// Meal Wizard — Shopping Tab
// Real-time shopping list with:
//   • Two-column compact grid layout
//   • Recipe source chips per item — tap to preview recipe
//   • Long press to enter selection mode
//   • Selection mode: select-all, bulk delete / mark purchased
//   • Manual item add modal
// ============================================================

import RecipeDetailModal from '@/components/RecipeDetailModal';
import { Colors, FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import {
  addManualItem,
  clearPurchasedItems,
  deleteShoppingItem,
  getRecipe,
  subscribeShoppingList,
  toggleShoppingItem,
} from '@/services/firestoreService';
import type { Recipe, ShoppingCategory, ShoppingItem } from '@/services/types';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Layout ───────────────────────────────────────────────────

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const ADD_SHEET_HEIGHT = SCREEN_HEIGHT * 0.82;

// ─── Constants ────────────────────────────────────────────────

const CATEGORY_ORDER: ShoppingCategory[] = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Herbs & Spices',
  'Oils, Sauces & Condiments',
  'Bread & Bakery',
  'Frozen',
  'Pantry & Dry Goods',
  'Other',
];

const CATEGORY_ICONS: Record<ShoppingCategory, string> = {
  'Produce': 'leaf-outline',
  'Meat & Seafood': 'fish-outline',
  'Dairy & Eggs': 'water-outline',
  'Herbs & Spices': 'flower-outline',
  'Oils, Sauces & Condiments': 'flask-outline',
  'Bread & Bakery': 'cafe-outline',
  'Frozen': 'snow-outline',
  'Pantry & Dry Goods': 'archive-outline',
  'Other': 'ellipsis-horizontal-circle-outline',
};

// ─── Paired-row types ─────────────────────────────────────────

type PairedRow = { left: ShoppingItem; right: ShoppingItem | null; id: string };
type ListSection = { title: string; data: PairedRow[]; isPurchased?: boolean };

function pairItems(items: ShoppingItem[]): PairedRow[] {
  const rows: PairedRow[] = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push({
      left: items[i],
      right: items[i + 1] ?? null,
      id: items[i].id ?? String(i),
    });
  }
  return rows;
}

// ─── Main Screen ──────────────────────────────────────────────

export default function ShoppingScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const { householdId } = useAuth();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);

  // Selection mode
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!householdId) return;
    return subscribeShoppingList(householdId, setItems);
  }, [householdId]);

  // ── Sections: unchecked by category (2-column pairs), then Purchased ──
  const sections = useMemo((): ListSection[] => {
    const unchecked = items.filter((i) => !i.checked);
    const checked = items.filter((i) => i.checked);

    const map: Partial<Record<ShoppingCategory, ShoppingItem[]>> = {};
    unchecked.forEach((item) => {
      if (!map[item.category]) map[item.category] = [];
      map[item.category]!.push(item);
    });

    const result: ListSection[] = CATEGORY_ORDER.filter((cat) => map[cat]?.length).map((cat) => ({
      title: cat,
      data: pairItems(map[cat]!.sort((a, b) => a.name.localeCompare(b.name))),
    }));

    if (checked.length > 0) {
      result.push({
        title: 'Purchased',
        data: pairItems(checked.sort((a, b) => a.name.localeCompare(b.name))),
        isPurchased: true,
      });
    }

    return result;
  }, [items]);

  const purchasedCount = items.filter((i) => i.checked).length;
  const totalCount = items.length;

  // ── Handlers ──────────────────────────────────────────────

  const handleToggle = useCallback(
    (item: ShoppingItem) => {
      if (!householdId || !item.id) return;
      toggleShoppingItem(householdId, item.id, !item.checked);
    },
    [householdId]
  );

  const handleDelete = useCallback(
    (item: ShoppingItem) => {
      if (!householdId || !item.id) return;
      deleteShoppingItem(householdId, item.id);
    },
    [householdId]
  );

  const handleRecipePress = useCallback(
    (recipeId: string) => {
      getRecipe(recipeId).then((r) => {
        if (r) setPreviewRecipe(r);
      }).catch(() => { });
    },
    []
  );

  // ── Selection mode ──────────────────────────────────────

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(items.map((i) => i.id!).filter(Boolean)));
  };

  const handleBulkDelete = useCallback(() => {
    if (!householdId) return;
    Promise.all(
      Array.from(selectedIds).map((id) => deleteShoppingItem(householdId, id))
    ).then(() => exitSelectionMode());
  }, [householdId, selectedIds]);

  const handleBulkMarkPurchased = useCallback(() => {
    if (!householdId) return;
    const unpurchased = items.filter(
      (i) => i.id && selectedIds.has(i.id) && !i.checked
    );
    Promise.all(
      unpurchased.map((i) => toggleShoppingItem(householdId, i.id!, true))
    ).then(() => exitSelectionMode());
  }, [householdId, selectedIds, items]);

  const handleClearPurchased = useCallback(() => {
    if (!householdId || purchasedCount === 0) return;
    clearPurchasedItems(householdId);
  }, [householdId, purchasedCount]);

  const selectedCount = selectedIds.size;

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: colors.text }]}>Shopping List</Text>
          {totalCount > 0 && (
            <Text style={[s.subtitle, { color: colors.textSecondary }]}>
              {totalCount - purchasedCount} remaining · {purchasedCount} purchased
            </Text>
          )}
        </View>

        {items.length > 0 && (
          selectionMode ? (
            <View style={s.headerActions}>
              <TouchableOpacity onPress={selectAll} style={[s.headerBtn, { borderColor: colors.primary }]}>
                <Text style={[s.headerBtnText, { color: colors.primary }]}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={exitSelectionMode} style={[s.headerBtn, { borderColor: colors.border }]}>
                <Text style={[s.headerBtnText, { color: colors.textSecondary }]}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => setSelectionMode(true)}
              style={[s.headerBtn, { borderColor: colors.border }]}
            >
              <Text style={[s.headerBtnText, { color: colors.textSecondary }]}>Select</Text>
            </TouchableOpacity>
          )
        )}
      </View>

      {/* ── List ── */}
      {items.length === 0 ? (
        <View style={s.emptyWrap}>
          <Ionicons name="cart-outline" size={52} color={colors.textTertiary} />
          <Text style={[s.emptyTitle, { color: colors.text }]}>Your list is empty</Text>
          <Text style={[s.emptyHint, { color: colors.textSecondary }]}>
            Generate a meal plan to automatically populate your shopping list, or tap + to add items manually.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(row) => row.id}
          contentContainerStyle={[
            s.listContent,
            { paddingBottom: insets.bottom + (selectionMode && selectedCount > 0 ? 140 : 90) },
          ]}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => {
            const sec = section as ListSection;
            const itemCount = sec.data.reduce((n, row) => n + 1 + (row.right ? 1 : 0), 0);
            return (
              <View style={s.sectionHeader}>
                {sec.isPurchased ? (
                  <Ionicons name="checkmark-circle-outline" size={14} color={colors.textTertiary} />
                ) : (
                  <Ionicons
                    name={CATEGORY_ICONS[sec.title as ShoppingCategory] as any}
                    size={20}
                    color={colors.textTertiary}
                  />
                )}
                <Text style={[s.sectionTitle, { color: colors.textTertiary }]}>
                  {sec.title}
                </Text>
                <Text style={[s.sectionCount, { color: colors.textTertiary }]}>
                  {itemCount}
                </Text>
                {sec.isPurchased && purchasedCount > 0 && (
                  <TouchableOpacity onPress={handleClearPurchased} style={s.clearBtn}>
                    <Ionicons name="trash-outline" size={14} color={colors.error} />
                    <Text style={[s.clearBtnText, { color: colors.error }]}>Clear</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          }}
          renderItem={({ item: row }) => (
            <View style={s.pairedRow}>
              <CompactShoppingItem
                item={row.left}
                colors={colors}
                selectionMode={selectionMode}
                selected={selectedIds.has(row.left.id ?? '')}
                onToggle={() => selectionMode ? toggleSelectItem(row.left.id ?? '') : handleToggle(row.left)}
                onLongPress={() => { setSelectionMode(true); toggleSelectItem(row.left.id ?? ''); }}
                onRecipePress={handleRecipePress}
              />
              {row.right ? (
                <CompactShoppingItem
                  item={row.right}
                  colors={colors}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(row.right.id ?? '')}
                  onToggle={() => selectionMode ? toggleSelectItem(row.right!.id ?? '') : handleToggle(row.right!)}
                  onLongPress={() => { setSelectionMode(true); toggleSelectItem(row.right!.id ?? ''); }}
                  onRecipePress={handleRecipePress}
                />
              ) : (
                <View style={s.pairedRowSpacer} />
              )}
            </View>
          )}
          renderSectionFooter={() => <View style={{ height: Spacing.xs }} />}
        />
      )}

      {/* ── Selection action bar ── */}
      {selectionMode && selectedCount > 0 && (
        <View style={[s.selectionBar, { bottom: insets.bottom + Spacing.lg, backgroundColor: colors.surface }]}>
          <TouchableOpacity
            style={[s.selBarBtn, { backgroundColor: colors.error + '18', flex: 1 }]}
            onPress={handleBulkDelete}
          >
            <Ionicons name="trash-outline" size={18} color={colors.error} />
            <Text style={[s.selBarBtnText, { color: colors.error }]}>Delete ({selectedCount})</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.selBarBtn, { backgroundColor: colors.primaryLight, flex: 1 }]}
            onPress={handleBulkMarkPurchased}
          >
            <Ionicons name="checkmark-circle-outline" size={18} color={colors.primary} />
            <Text style={[s.selBarBtnText, { color: colors.primary }]}>Purchased ({selectedCount})</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Floating Add button (hidden in selection mode) ── */}
      {!selectionMode && (
        <TouchableOpacity
          style={[s.fabPrimary, { bottom: insets.bottom + Spacing.lg, backgroundColor: colors.primary }, Shadows.md]}
          onPress={() => setShowAdd(true)}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={22} color="#fff" />
          <Text style={s.fabPrimaryText}>Add Item</Text>
        </TouchableOpacity>
      )}

      <AddItemModal
        visible={showAdd}
        colors={colors}
        householdId={householdId ?? ''}
        onClose={() => setShowAdd(false)}
      />

      <RecipeDetailModal
        recipe={previewRecipe}
        visible={!!previewRecipe}
        onClose={() => setPreviewRecipe(null)}
        onCourseUpdate={(id, course) =>
          setPreviewRecipe((prev) => prev?.id === id ? { ...prev, course } : prev)
        }
      />
    </SafeAreaView>
  );
}

// ─── Compact Shopping Item (2-column card) ────────────────────

function CompactShoppingItem({
  item,
  colors,
  selectionMode,
  selected,
  onToggle,
  onLongPress,
  onRecipePress,
}: {
  item: ShoppingItem;
  colors: (typeof Colors)['light'];
  selectionMode: boolean;
  selected: boolean;
  onToggle: () => void;
  onLongPress: () => void;
  onRecipePress: (recipeId: string) => void;
}) {
  return (
    <TouchableOpacity
      style={[
        s.compactCard,
        { backgroundColor: colors.surface },
        Shadows.sm,
        selected && { borderWidth: 2, borderColor: colors.primary },
      ]}
      onPress={onToggle}
      onLongPress={onLongPress}
      activeOpacity={0.75}
      delayLongPress={400}
    >
      {/* Checkbox / selection circle */}
      <View style={s.compactTop}>
        {selectionMode ? (
          <View
            style={[
              s.selectionCircle,
              { borderColor: selected ? colors.primary : colors.textTertiary },
              selected && { backgroundColor: colors.primary },
            ]}
          >
            {selected && <Ionicons name="checkmark" size={11} color="#fff" />}
          </View>
        ) : (
          <View
            style={[
              s.checkbox,
              { borderColor: item.checked ? colors.checked : colors.primary },
              item.checked && { backgroundColor: colors.checked },
            ]}
          >
            {item.checked && <Ionicons name="checkmark" size={11} color="#fff" />}
          </View>
        )}

        {item.manual && (
          <View style={[s.manualBadge, { backgroundColor: colors.accentLight }]}>
            <Text style={[s.manualText, { color: colors.accent }]}>manual</Text>
          </View>
        )}
      </View>

      {/* Item name */}
      <Text
        style={[
          s.itemName,
          { color: item.checked ? colors.textTertiary : colors.text },
          item.checked && s.strikethrough,
        ]}
        numberOfLines={2}
      >
        {item.name}
      </Text>

      {/* Quantity */}
      {(item.quantity > 0 || item.unit) && (
        <Text style={[s.itemQty, { color: item.checked ? colors.textTertiary : colors.textSecondary }]}>
          {item.quantity > 0 ? item.quantity : ''}{item.unit ? ` ${item.unit}` : ''}
        </Text>
      )}

      {/* Recipe source chips */}
      {item.sources && item.sources.length > 0 && (
        <View style={s.sourceChips}>
          {item.sources.map((src) => (
            <TouchableOpacity
              key={src.id}
              style={[s.sourceChip, { backgroundColor: colors.primaryLight }]}
              onPress={() => onRecipePress(src.id)}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            >
              <Ionicons name="book-outline" size={9} color={colors.primary} />
              <Text style={[s.sourceChipText, { color: colors.primary }]} numberOfLines={1}>
                {src.title}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── Add Item Bottom Drawer ───────────────────────────────────

function AddItemModal({
  visible,
  colors,
  householdId,
  onClose,
}: {
  visible: boolean;
  colors: (typeof Colors)['light'];
  householdId: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState<ShoppingCategory>('Other');
  const [saving, setSaving] = useState(false);

  const translateY = useRef(new Animated.Value(ADD_SHEET_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(() => { });

  const closeSheet = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: ADD_SHEET_HEIGHT, duration: 260, useNativeDriver: true }),
      Animated.timing(backdropOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      reset();
      onClose();
    });
  }, [onClose]);

  useEffect(() => { closeRef.current = closeSheet; }, [closeSheet]);

  useEffect(() => {
    if (visible) {
      translateY.setValue(ADD_SHEET_HEIGHT);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, tension: 62, friction: 11, useNativeDriver: true }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const reset = () => {
    setName('');
    setQuantity('1');
    setUnit('');
    setCategory('Other');
  };

  const handleAdd = async () => {
    if (!name.trim() || !householdId) return;
    setSaving(true);
    try {
      await addManualItem(householdId, name.trim(), parseFloat(quantity) || 1, unit.trim(), category);
      closeSheet();
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={closeSheet}
    >
      {/* Backdrop */}
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

      {/* Sheet */}
      <Animated.View
        style={[
          s.addSheet,
          {
            height: ADD_SHEET_HEIGHT,
            paddingBottom: insets.bottom + 24,
            backgroundColor: colors.background,
            transform: [{ translateY }],
          },
        ]}
      >
        {/* Drag handle */}
        <View style={s.addHandleWrap}>
          <View style={[s.addHandle, { backgroundColor: colors.border }]} />
        </View>

        {/* Top bar */}
        <View style={[s.addTopBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={closeSheet} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={[s.modalTitle, { color: colors.text }]}>Add Item</Text>
          <TouchableOpacity onPress={handleAdd} disabled={!name.trim() || saving}>
            <Text style={[s.modalDone, { color: name.trim() ? colors.primary : colors.textTertiary }]}>
              {saving ? '…' : 'Add'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Scrollable form */}
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
            <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>Item name</Text>
            <TextInput
              style={[s.input, { backgroundColor: colors.inputBackground, color: colors.text, borderColor: colors.border }]}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Chicken breast"
              placeholderTextColor={colors.textTertiary}
              autoFocus
            />

            <View style={s.qtyRow}>
              <View style={{ flex: 1 }}>
                <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>Qty</Text>
                <TextInput
                  style={[s.input, { backgroundColor: colors.inputBackground, color: colors.text, borderColor: colors.border }]}
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="decimal-pad"
                  placeholder="1"
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
              <View style={{ flex: 2 }}>
                <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>Unit</Text>
                <TextInput
                  style={[s.input, { backgroundColor: colors.inputBackground, color: colors.text, borderColor: colors.border }]}
                  value={unit}
                  onChangeText={setUnit}
                  placeholder="g, ml, cups…"
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
            </View>

            <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>Category</Text>
            <View style={s.catGrid}>
              {CATEGORY_ORDER.map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[
                    s.catChip,
                    { borderColor: category === cat ? colors.primary : colors.border },
                    category === cat && { backgroundColor: colors.primaryLight },
                  ]}
                  onPress={() => setCategory(cat)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.catChipText, { color: category === cat ? colors.primary : colors.textSecondary }]}>
                    {cat}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },
  title: { fontSize: FontSizes.xxl, fontFamily: Fonts.bold },
  subtitle: { fontSize: FontSizes.sm, marginTop: Spacing.xxs },
  headerActions: { flexDirection: 'row', gap: Spacing.sm },
  headerBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  headerBtnText: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold },

  // FAB
  fabPrimary: {
    position: 'absolute',
    left: Spacing.xl,
    right: Spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.pill,
  },
  fabPrimaryText: { color: '#fff', fontSize: FontSizes.md, fontFamily: Fonts.bold },

  // Selection action bar
  selectionBar: {
    position: 'absolute',
    left: Spacing.xl,
    right: Spacing.xl,
    flexDirection: 'row',
    gap: Spacing.sm,
    borderRadius: Radius.xl,
    padding: Spacing.sm,
    ...Shadows.md,
  },
  selBarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
  },
  selBarBtnText: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold },

  // List
  listContent: { paddingHorizontal: Spacing.xl },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  sectionTitle: {
    flex: 1,
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionCount: { fontSize: FontSizes.xs },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  clearBtnText: { fontSize: FontSizes.xs, fontFamily: Fonts.semibold },

  // Two-column paired row
  pairedRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  pairedRowSpacer: { flex: 1 },

  // Compact card (each column)
  compactCard: {
    flex: 1,
    borderRadius: Radius.xl,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  compactTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xxs,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: Radius.xs,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  selectionCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  itemName: { fontSize: FontSizes.lg, fontFamily: Fonts.semibold, lineHeight: 22 },
  itemQty: { fontSize: FontSizes.xs, marginTop: 1 },
  strikethrough: { textDecorationLine: 'line-through' },
  manualBadge: {
    paddingHorizontal: Spacing.xs,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  manualText: { fontSize: 9, fontFamily: Fonts.semibold },

  // Recipe source chips
  sourceChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
    marginTop: Spacing.xs,
  },
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: Spacing.xs,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    maxWidth: '100%',
  },
  sourceChipText: {
    fontSize: 11,
    fontFamily: Fonts.medium,
    flexShrink: 1,
  },

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

  // Add item bottom drawer
  addSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    ...Shadows.lg,
  },
  addHandleWrap: {
    alignItems: 'center',
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  addHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  addTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },
  modalDone: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },
  modalScroll: { padding: Spacing.xl, gap: Spacing.xs },
  fieldLabel: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
  },
  input: {
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSizes.md,
  },
  qtyRow: { flexDirection: 'row', gap: Spacing.md },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.xs },
  catChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  catChipText: { fontSize: FontSizes.sm, fontFamily: Fonts.medium },
});
