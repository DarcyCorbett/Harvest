import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConnected } from '@/contexts/ConnectedContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Fonts, Shadows } from '@/constants/theme';
import { requestId, type ListItem } from '@/services/connectedClient';
import { Button, Field, Heading, Row, report } from './ui';
import { Caption, IconButton, Pill, Sheet, StatusNotice } from './classic';
import { QUICK_ADD_BY_CATEGORY } from '@/constants/shoppingQuickAdd';
import RecipeDetailModal from '@/components/RecipeDetailModal';
import type { Recipe } from '@/services/types';
import { purchasedItems, commandHasItem, shoppingDisplayGroups, type ShoppingDisplayGroup } from '@/services/shoppingPresentation';
import { combineAmounts, formatAmount } from '@/functions/src/shared/ingredientAmounts';

const sourceOccasions = (sources: ListItem['contributions']) => [...new Map(sources.map(source => [JSON.stringify([source.mealId, source.recipeId]), source])).values()];
const categories = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Herbs & Spices', 'Oils, Sauces & Condiments', 'Bread & Bakery', 'Frozen', 'Pantry & Dry Goods', 'Drinks & Beverages', 'Personal Care', 'Household & Cleaning', 'Other'];
const emoji: Record<string, string> = { Produce: '🥬', 'Meat & Seafood': '🐟', 'Dairy & Eggs': '🥚', 'Herbs & Spices': '🌿', 'Oils, Sauces & Condiments': '🫒', 'Bread & Bakery': '🥖', Frozen: '❄️', 'Pantry & Dry Goods': '🍚', 'Drinks & Beverages': '☕', 'Personal Care': '🧴', 'Household & Cleaning': '🧽', Other: '🛒', Purchased: '✓' };

export default function ShoppingScreen() {
  const c = useConnected();
  return <ShoppingList key={`${c.period?.id}:${c.period?.shopping?.generation}`} />;
}

function ShoppingList() {
  const c = useConnected(), { colors } = useTheme(), router = useRouter();
  const [preview, setPreview] = useState<Recipe | null>(null);
  const [previewServings, setPreviewServings] = useState<number | undefined>();
  const [recipeLoading, setRecipeLoading] = useState(false);
  const previewRequest = useRef(0);
  React.useEffect(() => () => { previewRequest.current++; }, []);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selection, setSelection] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [add, setAdd] = useState(false), [name, setName] = useState(''), [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState(''), [category, setCategory] = useState('Other'), [saving, setSaving] = useState(false);
  const [lastAdded, setLastAdded] = useState<{ id: string; name: string } | null>(null);
  const [quickRequest, setQuickRequest] = useState<{ id: string; name: string; category: string } | null>(null);
  const savingRef = useRef(false), nameInput = useRef<TextInput>(null);
  const [footerHeight, setFooterHeight] = useState(64);
  const items = c.period?.items ?? [];
  const locked = !c.period?.shopping || !!c.state?.shoppingUpdate?.replace;
  const pendingFor = (item: ListItem | ShoppingDisplayGroup) => c.pending.find(p => {
    const command = p.command as { itemId?: string; periodId?: string; generation?: string };
    return ('items' in item ? item.items : [item]).some(member => commandHasItem(command, member.id)) && command.periodId === c.period?.id && command.generation === c.period?.shopping?.generation;
  });
  const purchasedRows = purchasedItems(items, c.pending, c.period?.id);
  const isChecked = (item: ListItem) => purchasedRows.some(i => i.id === item.id);
  const activeRows = items.filter(i => !isChecked(i) && !i.dismissed && !c.pending.some(p => !p.error && commandHasItem(p.command, i.id) && (p.command as any).action === 'delete'));
  const active = shoppingDisplayGroups(activeRows, false), purchased = shoppingDisplayGroups(purchasedRows, true);
  const groups = [...active, ...purchased], detail = groups.find(group => group.id === detailId);
  const aisles = [...new Set(active.map(i => i.category))].sort((a, b) => {
    const ai = categories.indexOf(a), bi = categories.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
  });
  const openRecipe = async (source: ListItem['contributions'][number]) => {
    setDetailId(null);
    const request = ++previewRequest.current; setRecipeLoading(true);
    try {
      const recipe = await c.load(source.recipeId);
      if (request !== previewRequest.current) return;
      if (!recipe) throw new Error('This recipe is unavailable.');
      setPreviewServings(source.servings ?? c.meals.find(meal => meal.id === source.mealId)?.servings);
      setPreview(recipe);
    } catch (e) { if (request === previewRequest.current) report(e); }
    finally { if (request === previewRequest.current) setRecipeLoading(false); }
  };
  const toggle = (item: ShoppingDisplayGroup) => {
    if (selection) setSelected(v => v.includes(item.id) ? v.filter(id => id !== item.id) : [...v, item.id]);
    else c.checkGroup(item.items, item.checked ? 'uncheck' : 'check').catch(report);
  };
  const saveManual = async () => {
    if (savingRef.current) return;
    const number = Number(quantity);
    if (!Number.isFinite(number) || number < 0) { report(new Error('Enter a valid quantity.')); return; }
    savingRef.current = true; setSaving(true);
    try {
      const outcome = await c.addManual({ name: name.trim(), quantity: number, unit, category });
      setLastAdded({ id: '', name: outcome === 'queued' ? `${name.trim()} (will sync when online)` : name }); setName(''); setQuantity('1'); setUnit('');
      nameInput.current?.focus();
    } catch (e) { report(e); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const saveQuick = async (item: { id: string; name: string; category: string }) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setQuickRequest(item);
    try {
      const outcome = await c.addManual({ name: item.name, quantity: 1, unit: '', category: item.category }, item.id);
      setLastAdded(outcome === 'queued' ? { id: '', name: `${item.name} (will sync when online)` } : { id: `manual-${item.id}`, name: item.name }); setQuickRequest(null);
    } catch (e) { report(e); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const bulk = async (action: 'check' | 'delete') => {
    try {
      await c.checkGroup(groups.filter(group => selected.includes(group.id)).flatMap(group => group.items), action);
      setSelection(false); setSelected([]);
    } catch (e) { report(e); }
  };
  const recipePill = (source: ListItem['contributions'][number]) => <Pressable key={`${source.mealId}:${source.recipeId}`}
    accessibilityRole="button" accessibilityLabel={`View ${source.title}`} onPress={() => openRecipe(source)}
    style={{ minHeight: 44, maxWidth: '100%', justifyContent: 'center', backgroundColor: colors.primaryLight, borderRadius: 18, paddingHorizontal: 10 }}>
    <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.primary, fontFamily: Fonts.medium, fontSize: 12, flexShrink: 1 }}>{source.title}</Text>
  </Pressable>;
  const card = (item: ShoppingDisplayGroup) => {
    const pending = pendingFor(item), checked = item.checked, sources = sourceOccasions(item.contributions);
    const open = expanded.includes(item.id), selectedItem = selected.includes(item.id);
    return <View key={item.id} style={{ width: '100%', padding: 12, borderRadius: 20, backgroundColor: colors.surface, ...Shadows.sm, borderWidth: selectedItem ? 2 : 0, borderColor: colors.primary }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable accessibilityRole="checkbox" accessibilityLabel={`${checked ? 'Uncheck' : 'Purchase'} ${item.name}, ${item.label}`}
          accessibilityState={{ checked: selection ? selectedItem : checked, disabled: locked || !!pending }} disabled={locked || !!pending}
          onPress={() => toggle(item)} onLongPress={() => { setSelection(true); setSelected([item.id]); }}
          style={{ flex: 1, minWidth: 0, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 22, height: 22, borderWidth: 2, borderRadius: 7, borderColor: colors.primary, backgroundColor: (selection ? selectedItem : checked) ? colors.primary : 'transparent' }}>
            {(selection ? selectedItem : checked) && <Ionicons name="checkmark" size={17} color={colors.textInverse} />}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 17, lineHeight: 23, fontFamily: Fonts.semibold, color: checked ? colors.textSecondary : colors.text, textDecorationLine: checked ? 'line-through' : 'none' }}>{item.name}</Text>
            <Caption>{item.label}</Caption>
          </View>
        </Pressable>
        {!!sources.length && <View style={{ width: '36%', minWidth: 0 }}>
          {sources.length === 1 ? recipePill(sources[0]) : <Pressable accessibilityRole="button"
            accessibilityLabel={`${open ? 'Hide' : 'Show'} all ${sources.length} recipes for ${item.name}`} accessibilityState={{ expanded: open }}
            accessibilityHint={sources[0].title}
            onPress={() => setExpanded(v => open ? v.filter(id => id !== item.id) : [...v, item.id])}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.primaryLight, borderRadius: 18, paddingHorizontal: 8 }}>
            <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, minWidth: 0, color: colors.primary, fontFamily: Fonts.medium, fontSize: 12 }}>{sources[0].title}</Text>
            <Text style={{ color: colors.primary, fontSize: 12 }}>+{sources.length - 1}</Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.primary} />
          </Pressable>}
        </View>}
        <IconButton icon="ellipsis-vertical" label={`Options for ${item.name}`} onPress={() => setDetailId(item.id)} />
      </View>
      {open && sources.length > 1 && <View style={{ gap: 5, marginTop: 8 }}>{sources.map(recipePill)}</View>}
      {pending && <View accessibilityLabel={pending.error ? 'Sync needs attention' : 'Saving shopping change'} style={{ position: 'absolute', right: 8, bottom: 4 }}>
        <Ionicons name={pending.error ? 'alert-circle-outline' : 'cloud-upload-outline'} size={12} color={colors.textSecondary} />
      </View>}
    </View>;
  };
  const section = (title: string, group: ShoppingDisplayGroup[]) => !!group.length && <View key={title} style={{ gap: 10, marginBottom: 20 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: colors.textSecondary }}>{emoji[title] ?? '🛒'}</Text>
      <Text style={{ flex: 1, fontFamily: Fonts.semibold, fontSize: 14, color: colors.textSecondary }}>{title.toUpperCase()}</Text>
      <Caption>{group.length}</Caption>
    </View>
    {group.map(card)}
  </View>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'left', 'right']}>
    <View style={{ flex: 1, minHeight: 0, width: '100%', maxWidth: 880, alignSelf: 'center' }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}><Text accessibilityRole="header" style={{ fontFamily: Fonts.bold, fontSize: 28, color: colors.text }}>Shopping List</Text><Caption>{active.length} remaining · {purchased.length} purchased</Caption></View>
        <Pill label={selection ? 'Done' : 'Select'} onPress={() => { setSelection(!selection); setSelected([]); }} />
        <IconButton icon="settings-outline" label="Settings" onPress={() => router.push('/profile')} />
      </View>
      {c.shoppingUpdating && <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center' }}>
        <ActivityIndicator color={colors.primary} /><Caption>Updating shopping list…</Caption>
      </View>}
      <StatusNotice hideShoppingProgress hidePendingProgress />
      {!c.shoppingUpdating && c.period?.groupingStatus === 'fallback' && <View style={{ paddingHorizontal: 20 }}><Caption>All ingredients are ready. Basic grouping is active.</Caption></View>}
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: footerHeight + 32 }}>
        {c.pending.filter(p => p.error).map(p => <View key={p.id} style={{ gap: 8, marginBottom: 16 }}><Caption>{p.error}</Caption><Pill label="Dismiss failed change" onPress={() => c.dismissPending(p.id).catch(report)} /></View>)}
        {!items.length && !c.shoppingUpdating && <View style={{ alignItems: 'center', paddingVertical: 60, gap: 16 }}><Text style={{ fontSize: 52 }}>🛒</Text><Heading>Your list is empty</Heading><Caption>Add meals or a few essentials to get started.</Caption><Pill label="Plan meals" onPress={() => router.push('/')} /></View>}
        {aisles.map(category => section(category, active.filter(i => i.category === category)))}
        {section('Purchased', purchased)}
      </ScrollView>
      <View onLayout={e => setFooterHeight(e.nativeEvent.layout.height)} style={{ position: 'absolute', bottom: 16, left: 20, right: 20, borderRadius: 24, ...Shadows.md }}>
        {selection ? <View style={{ backgroundColor: colors.surface, padding: 12, borderRadius: 24 }}><Row>
          <Pill label="All" onPress={() => setSelected(groups.filter(i => !pendingFor(i)).map(i => i.id))} />
          <Pill label={`Purchased (${selected.length})`} disabled={!selected.length || locked} onPress={() => bulk('check')} />
          <Pill label="Remove" disabled={!selected.length || locked} onPress={() => bulk('delete')} />
        </Row></View> : <Button label="＋ Add items" disabled={locked} onPress={() => setAdd(true)} />}
      </View>
      {add && <Sheet title="Add items" onClose={() => { if (!saving) setAdd(false); }} footer={<Row><View style={{ flex: 1 }}><Button label={saving ? 'Adding…' : 'Add item'} disabled={saving || locked || !name.trim()} onPress={saveManual} /></View><Button label="Done" secondary disabled={saving} onPress={() => setAdd(false)} /></Row>}>
        <Field ref={nameInput} label="Item" value={name} onChangeText={setName} returnKeyType="next" />
        <Row><View style={{ flex: 1 }}><Field label="Quantity" value={quantity} keyboardType="decimal-pad" onChangeText={setQuantity} /></View><View style={{ flex: 1 }}><Field label="Unit" value={unit} onChangeText={setUnit} /></View></Row>
        {lastAdded && <Row><Text accessibilityLiveRegion="polite" style={{ color: colors.primary }}>Added {lastAdded.name}</Text>{!!lastAdded.id && <Pill label="Undo" disabled={saving || !c.online || locked || !items.some(i => i.id === lastAdded.id)} onPress={async () => {
          const item = items.find(i => i.id === lastAdded.id); if (!item) return;
          try { await c.check(item, 'delete'); setLastAdded(null); } catch (e) { report(e); }
        }} />}</Row>}
        <Caption>Aisle</Caption><Row>{categories.map(value => <Pill key={value} label={`${emoji[value]} ${value}`} selected={category === value} onPress={() => setCategory(value)} />)}</Row>
        {!!QUICK_ADD_BY_CATEGORY[category as keyof typeof QUICK_ADD_BY_CATEGORY]?.length && <><Caption>Quick add from {category}</Caption><Row>{QUICK_ADD_BY_CATEGORY[category as keyof typeof QUICK_ADD_BY_CATEGORY]!.map(item => <Pill key={item} label={item} disabled={saving || locked} onPress={() => saveQuick({ id: requestId(), name: item, category })} />)}</Row></>}
        {quickRequest && !saving && <Pill label={`Retry ${quickRequest.name}`} onPress={() => saveQuick(quickRequest)} />}
      </Sheet>}
      {detail && <Sheet title={detail.name} onClose={() => setDetailId(null)}>
        <Heading>{detail.label}</Heading>
        <Button label="Remove item" secondary disabled={locked || !!pendingFor(detail)} onPress={() => c.checkGroup(detail.items, 'delete').then(() => setDetailId(null)).catch(report)} />
        {detail.contributions.map((source, index) => <View key={index} style={{ gap: 4 }}>
          {recipePill(source)}
          <Caption>{combineAmounts([source.sourceAmount ?? { quantity: source.quantity, unit: detail.items.find(item => item.contributions.includes(source))?.unit ?? '' }]).map(formatAmount).join(' + ')}{source.servings ? ` · for ${source.servings} servings` : ''}</Caption>
        </View>)}
      </Sheet>}
      {recipeLoading && <Sheet title="Loading recipe…" onClose={() => { previewRequest.current++; setRecipeLoading(false); }}><ActivityIndicator color={colors.primary} /></Sheet>}
      <RecipeDetailModal key={`${preview?.id}:${previewServings}`} defaultServings={previewServings} recipe={preview} visible={!!preview} onClose={() => setPreview(null)} />
    </View>
  </SafeAreaView>;
}
