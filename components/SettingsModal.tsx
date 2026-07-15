// ============================================================
// Meal Wizard — Settings Modal
// Per-household generation settings: source weights, ingredient
// weights, seed selection, and kid friendly filters.
// ============================================================

import { FontSizes, Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/contexts/ThemeContext';
import TimePickerModal from './TimePickerModal';
import {
  getHouseholdSettings,
  saveHouseholdSettings,
} from '@/services/firestoreService';
import { DEFAULT_MEAL_REMINDERS } from '@/services/mealRemindersConstants';
import { clearDevLog, formatDevLog, getDevLog, type DevLogEntry } from '@/services/devLog';
import * as Clipboard from 'expo-clipboard';
import { KID_FRIENDLY_DEFAULTS, SEED_INGREDIENT_OPTIONS, TRUSTED_SITES } from '@/services/recipeScraperService';
import type { HouseholdSettings, KidFriendlySettings } from '@/services/types';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface SettingsModalProps {
  visible: boolean;
  onClose: () => void;
  householdId: string;
  onSaved: () => void;
}

/** Strip leading www. for display */
function displayDomain(site: string): string {
  return site.replace(/^www\./, '');
}

/** All default blocked terms as a flat list */
const ALL_DEFAULT_TERMS = [
  ...KID_FRIENDLY_DEFAULTS.hotIngredients,
  ...KID_FRIENDLY_DEFAULTS.adultFlavours,
  ...KID_FRIENDLY_DEFAULTS.alcohol,
];

export default function SettingsModal({
  visible,
  onClose,
  householdId,
  onSaved,
}: SettingsModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sourceWeights, setSourceWeights] = useState<Record<string, number>>({});
  const [ingredientWeights, setIngredientWeights] = useState<Record<string, number>>({});
  const [kidFriendly, setKidFriendly] = useState<KidFriendlySettings>({});
  const [newBlockTerm, setNewBlockTerm] = useState('');

  // Meal reminders
  const [defrostEnabled, setDefrostEnabled] = useState(DEFAULT_MEAL_REMINDERS.defrostEnabled);
  const [marinateEnabled, setMarinateEnabled] = useState(DEFAULT_MEAL_REMINDERS.marinateEnabled);
  const [morningTime, setMorningTime] = useState(DEFAULT_MEAL_REMINDERS.morningTime);
  const [eveningTime, setEveningTime] = useState(DEFAULT_MEAL_REMINDERS.eveningTime);
  const isValidHHMM = (s: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);

  // Default servings and strict tag matching
  const [defaultAdults, setDefaultAdults] = useState(2);
  const [defaultChildren, setDefaultChildren] = useState(2);
  const [strictMatching, setStrictMatching] = useState(true);

  // Time picker modal visibility
  const [morningPickerVisible, setMorningPickerVisible] = useState(false);
  const [eveningPickerVisible, setEveningPickerVisible] = useState(false);

  // ── Hidden debug-log viewer (tap version footer 5x to reveal) ──
  const [debugTapCount, setDebugTapCount] = useState(0);
  const [debugLogVisible, setDebugLogVisible] = useState(false);
  const [debugLogEntries, setDebugLogEntries] = useState<DevLogEntry[]>([]);
  const onVersionTap = useCallback(async () => {
    const next = debugTapCount + 1;
    if (next >= 5) {
      setDebugTapCount(0);
      const entries = await getDevLog();
      setDebugLogEntries(entries);
      setDebugLogVisible(true);
    } else {
      setDebugTapCount(next);
    }
  }, [debugTapCount]);
  const onCopyLog = useCallback(async () => {
    await Clipboard.setStringAsync(formatDevLog(debugLogEntries));
    Alert.alert('Copied', `${debugLogEntries.length} log entries copied to clipboard.`);
  }, [debugLogEntries]);
  const onClearLog = useCallback(async () => {
    await clearDevLog();
    setDebugLogEntries([]);
  }, []);

  // Remember the last non-zero weight for each site so toggling off→on restores it
  const [lastNonZeroSource, setLastNonZeroSource] = useState<Record<string, number>>({});

  // Load settings from Firestore whenever the modal opens
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    getHouseholdSettings(householdId)
      .then((s: HouseholdSettings) => {
        setSourceWeights(s.sourceWeights);
        setIngredientWeights(s.ingredientWeights);
        setKidFriendly(s.kidFriendly ?? {});
        const mr = s.mealReminders ?? DEFAULT_MEAL_REMINDERS;
        setDefrostEnabled(mr.defrostEnabled);
        setMarinateEnabled(mr.marinateEnabled);
        setMorningTime(mr.morningTime);
        setEveningTime(mr.eveningTime);
        setDefaultAdults(s.defaultAdults ?? 2);
        setDefaultChildren(s.defaultChildren ?? 2);
        setStrictMatching(s.strictMatching ?? true);
        // Pre-populate lastNonZero from existing weights
        const lnz: Record<string, number> = {};
        TRUSTED_SITES.forEach((site) => {
          const w = s.sourceWeights[site];
          if (w && w > 0) lnz[site] = w;
        });
        setLastNonZeroSource(lnz);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible, householdId]);

  // ── Source helpers ─────────────────────────────────────────

  const getSourceWeight = (site: string): number =>
    sourceWeights[site] ?? 1;

  const isSourceEnabled = (site: string): boolean =>
    getSourceWeight(site) !== 0;

  const toggleSource = useCallback((site: string) => {
    setSourceWeights((prev) => {
      const current = prev[site] ?? 1;
      if (current !== 0) {
        setLastNonZeroSource((lnz) => ({ ...lnz, [site]: current }));
        return { ...prev, [site]: 0 };
      } else {
        const restore = lastNonZeroSource[site] ?? 1;
        return { ...prev, [site]: restore };
      }
    });
  }, [lastNonZeroSource]);

  const setSourceWeight = useCallback((site: string, w: number) => {
    setSourceWeights((prev) => ({ ...prev, [site]: w }));
    setLastNonZeroSource((lnz) => ({ ...lnz, [site]: w }));
  }, []);

  // ── Ingredient weight helpers ──────────────────────────────

  const getIngredientWeight = (name: string): number =>
    ingredientWeights[name] ?? 1;

  const cycleIngredientWeight = useCallback((name: string) => {
    setIngredientWeights((prev) => {
      const current = prev[name] ?? 1;
      const next = current >= 3 ? 1 : current + 1;
      return { ...prev, [name]: next };
    });
  }, []);

  // ── Kid Friendly helpers ───────────────────────────────────

  const isDefaultTermAllowed = (term: string): boolean =>
    (kidFriendly.allowedExceptions ?? []).includes(term);

  const toggleDefaultTermException = useCallback((term: string) => {
    setKidFriendly((prev) => {
      const current = prev.allowedExceptions ?? [];
      const updated = current.includes(term)
        ? current.filter((t) => t !== term)
        : [...current, term];
      return { ...prev, allowedExceptions: updated };
    });
  }, []);

  const addCustomBlockTerm = useCallback(() => {
    const trimmed = newBlockTerm.trim().toLowerCase();
    if (!trimmed) return;
    setKidFriendly((prev) => {
      const current = prev.excludedIngredients ?? [];
      if (current.includes(trimmed)) return prev;
      return { ...prev, excludedIngredients: [...current, trimmed] };
    });
    setNewBlockTerm('');
  }, [newBlockTerm]);

  const removeCustomBlockTerm = useCallback((term: string) => {
    setKidFriendly((prev) => ({
      ...prev,
      excludedIngredients: (prev.excludedIngredients ?? []).filter((t) => t !== term),
    }));
  }, []);

  // ── Save ──────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!isValidHHMM(morningTime) || !isValidHHMM(eveningTime)) {
      Alert.alert('Invalid time', 'Reminder times must use HH:MM (24-hour) format.');
      return;
    }
    setSaving(true);
    try {
      await saveHouseholdSettings(householdId, {
        sourceWeights,
        ingredientWeights,
        kidFriendly: (kidFriendly.allowedExceptions?.length || kidFriendly.excludedIngredients?.length)
          ? kidFriendly
          : undefined,
        mealReminders: {
          defrostEnabled,
          marinateEnabled,
          morningTime,
          eveningTime,
        },
        defaultAdults,
        defaultChildren,
        strictMatching,
      });
      onSaved();
      onClose();
    } catch (err) {
      console.error('[SettingsModal] save failed:', err);
      Alert.alert('Error', `Could not save settings.\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [householdId, sourceWeights, ingredientWeights, kidFriendly, defrostEnabled, marinateEnabled, morningTime, eveningTime, defaultAdults, defaultChildren, strictMatching, onSaved, onClose]);

  // ── Render ────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.closeBtn}
          >
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Generation Settings</Text>
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving || loading}
            style={styles.saveBtn}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            {/* ── Default Servings ── */}
            <Text style={styles.sectionTitle}>Default Servings</Text>
            <Text style={styles.sectionHint}>
              Configure the default number of adults and children preselected when launching a new generation plan.
            </Text>
            <View style={styles.servingsRow}>
              <View style={styles.servingCounter}>
                <Text style={styles.servingLabel}>Adults</Text>
                <View style={styles.counterControls}>
                  <TouchableOpacity
                    onPress={() => {
                      if (defaultAdults > 1) setDefaultAdults(defaultAdults - 1);
                    }}
                    disabled={defaultAdults <= 1}
                    style={[styles.counterBtn, { opacity: defaultAdults <= 1 ? 0.4 : 1 }]}
                  >
                    <Ionicons name="remove-circle-outline" size={28} color={colors.text} />
                  </TouchableOpacity>
                  <Text style={styles.counterValue}>
                    {defaultAdults}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (defaultAdults < 20) setDefaultAdults(defaultAdults + 1);
                    }}
                    disabled={defaultAdults >= 20}
                    style={[styles.counterBtn, { opacity: defaultAdults >= 20 ? 0.4 : 1 }]}
                  >
                    <Ionicons name="add-circle-outline" size={28} color={colors.text} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.servingDivider} />

              <View style={styles.servingCounter}>
                <Text style={styles.servingLabel}>Children</Text>
                <View style={styles.counterControls}>
                  <TouchableOpacity
                    onPress={() => {
                      if (defaultChildren > 0) setDefaultChildren(defaultChildren - 1);
                    }}
                    disabled={defaultChildren <= 0}
                    style={[styles.counterBtn, { opacity: defaultChildren <= 0 ? 0.4 : 1 }]}
                  >
                    <Ionicons name="remove-circle-outline" size={28} color={colors.text} />
                  </TouchableOpacity>
                  <Text style={styles.counterValue}>
                    {defaultChildren}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (defaultChildren < 20) setDefaultChildren(defaultChildren + 1);
                    }}
                    disabled={defaultChildren >= 20}
                    style={[styles.counterBtn, { opacity: defaultChildren >= 20 ? 0.4 : 1 }]}
                  >
                    <Ionicons name="add-circle-outline" size={28} color={colors.text} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.divider} />

            {/* ── Meal Generation Matching ── */}
            <Text style={styles.sectionTitle}>Meal Generation Matching</Text>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextCol}>
                <Text style={styles.toggleLabel}>Strict Tag Matching</Text>
                <Text style={styles.toggleDesc}>
                  When enabled, the generator automatically regenerates meals in the background until all selected criteria (like Healthy, Dinner, Quick & Easy) are fully met.
                </Text>
              </View>
              <Switch
                value={strictMatching}
                onValueChange={setStrictMatching}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#ffffff"
              />
            </View>

            <View style={styles.divider} />

            {/* ── Sources ── */}
            <Text style={styles.sectionTitle}>Recipe Sources</Text>
            <Text style={styles.sectionHint}>
              Toggle sites on/off and adjust how often each is used.
            </Text>

            {TRUSTED_SITES.map((site) => {
              const enabled = isSourceEnabled(site);
              const weight = enabled ? getSourceWeight(site) : (lastNonZeroSource[site] ?? 1);
              return (
                <View key={site} style={styles.sourceRow}>
                  <View style={styles.sourceLeft}>
                    <Switch
                      value={enabled}
                      onValueChange={() => toggleSource(site)}
                      trackColor={{ false: '#D1D5DB', true: colors.primaryLight }}
                      thumbColor={enabled ? colors.primary : '#9CA3AF'}
                    />
                    <Text style={[styles.sourceName, !enabled && styles.disabledText]}>
                      {displayDomain(site)}
                    </Text>
                  </View>
                  <View style={[styles.weightChips, !enabled && styles.disabledChips]}>
                    {([1, 2, 3] as const).map((w) => (
                      <TouchableOpacity
                        key={w}
                        onPress={() => {
                          if (!enabled) return;
                          setSourceWeight(site, w);
                        }}
                        style={[
                          styles.weightChip,
                          weight === w && enabled && styles.weightChipActive,
                          !enabled && styles.weightChipDisabled,
                        ]}
                        activeOpacity={enabled ? 0.7 : 1}
                      >
                        <Text
                          style={[
                            styles.weightChipText,
                            weight === w && enabled && styles.weightChipTextActive,
                            !enabled && styles.disabledText,
                          ]}
                        >
                          {w}×
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              );
            })}

            <View style={styles.divider} />

            {/* ── Ingredient Weights ── */}
            <Text style={styles.sectionTitle}>Ingredient Weights</Text>
            <Text style={styles.sectionHint}>
              Tap a chip to cycle its weight (1× → 2× → 3×). Higher weight means that ingredient appears more often in random selection.
            </Text>

            <View style={styles.ingredientGrid}>
              {SEED_INGREDIENT_OPTIONS.map((name) => {
                const w = getIngredientWeight(name);
                const active = w > 1;
                return (
                  <TouchableOpacity
                    key={name}
                    onPress={() => cycleIngredientWeight(name)}
                    style={[
                      styles.ingredientChip,
                      active && styles.ingredientChipActive,
                    ]}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.ingredientChipText,
                        active && styles.ingredientChipTextActive,
                      ]}
                    >
                      {name} {w > 1 ? `×${w}` : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.divider} />

            {/* ── Kid Friendly Filters ── */}
            <Text style={styles.sectionTitle}>Kid Friendly Filters</Text>
            <Text style={styles.sectionHint}>
              When &ldquo;Kid Friendly&rdquo; is selected during generation, recipes containing any blocked ingredient are skipped. Tap a default term to allow it through. Add custom terms below.
            </Text>

            <Text style={styles.subSectionLabel}>Default blocked ingredients</Text>
            <View style={styles.ingredientGrid}>
              {ALL_DEFAULT_TERMS.map((term) => {
                const allowed = isDefaultTermAllowed(term);
                return (
                  <TouchableOpacity
                    key={term}
                    onPress={() => toggleDefaultTermException(term)}
                    style={[
                      styles.ingredientChip,
                      allowed && styles.allowedChip,
                    ]}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.ingredientChipText,
                        allowed && styles.allowedChipText,
                      ]}
                    >
                      {allowed ? '✓ ' : ''}{term}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.subSectionLabel, { marginTop: Spacing.md }]}>Custom blocked ingredients</Text>
            <View style={styles.addTermRow}>
              <TextInput
                style={styles.addTermInput}
                value={newBlockTerm}
                onChangeText={setNewBlockTerm}
                placeholder="e.g. wasabi"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={addCustomBlockTerm}
              />
              <TouchableOpacity
                onPress={addCustomBlockTerm}
                style={styles.addTermBtn}
                activeOpacity={0.7}
              >
                <Ionicons name="add" size={20} color={colors.primary} />
              </TouchableOpacity>
            </View>

            {(kidFriendly.excludedIngredients ?? []).length > 0 && (
              <View style={[styles.ingredientGrid, { marginTop: Spacing.sm }]}>
                {(kidFriendly.excludedIngredients ?? []).map((term) => (
                  <TouchableOpacity
                    key={term}
                    onPress={() => removeCustomBlockTerm(term)}
                    style={[styles.ingredientChip, styles.customBlockChip]}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.ingredientChipText, styles.customBlockChipText]}>
                      {term} ×
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={styles.divider} />

            {/* ── Meal Reminders ── */}
            <Text style={styles.sectionTitle}>Meal Reminders</Text>
            <Text style={styles.sectionHint}>
              Get notified the morning of meals using frozen meat or fish, and the evening before meals that need marinating.
            </Text>

            <View style={styles.reminderRow}>
              <View style={styles.reminderTextWrap}>
                <Text style={styles.reminderTitle}>Defrost reminders</Text>
                <Text style={styles.reminderSubtitle}>Reminds you the morning of a meal that uses frozen meat or fish.</Text>
              </View>
              <Switch
                value={defrostEnabled}
                onValueChange={setDefrostEnabled}
                trackColor={{ false: '#D1D5DB', true: colors.primaryLight }}
                thumbColor={defrostEnabled ? colors.primary : '#9CA3AF'}
              />
            </View>

            <View style={styles.reminderRow}>
              <View style={styles.reminderTextWrap}>
                <Text style={styles.reminderTitle}>Marinate reminders</Text>
                <Text style={styles.reminderSubtitle}>Reminds you the evening before a meal that needs marinating.</Text>
              </View>
              <Switch
                value={marinateEnabled}
                onValueChange={setMarinateEnabled}
                trackColor={{ false: '#D1D5DB', true: colors.primaryLight }}
                thumbColor={marinateEnabled ? colors.primary : '#9CA3AF'}
              />
            </View>

            <View style={styles.reminderRow}>
              <Text style={[styles.reminderTitle, { flex: 1 }]}>Morning reminder time</Text>
              <TouchableOpacity
                onPress={() => setMorningPickerVisible(true)}
                style={styles.timePickerTrigger}
                activeOpacity={0.7}
              >
                <Text style={styles.timePickerTriggerText}>{morningTime}</Text>
                <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.reminderRow}>
              <Text style={[styles.reminderTitle, { flex: 1 }]}>Evening reminder time</Text>
              <TouchableOpacity
                onPress={() => setEveningPickerVisible(true)}
                style={styles.timePickerTrigger}
                activeOpacity={0.7}
              >
                <Text style={styles.timePickerTriggerText}>{eveningTime}</Text>
                <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <TimePickerModal
              visible={morningPickerVisible}
              value={morningTime}
              onClose={() => setMorningPickerVisible(false)}
              onSelect={setMorningTime}
              title="Morning Reminder"
            />

            <TimePickerModal
              visible={eveningPickerVisible}
              value={eveningTime}
              onClose={() => setEveningPickerVisible(false)}
              onSelect={setEveningTime}
              title="Evening Reminder"
            />

            <View style={styles.divider} />

            {/* Hidden debug-log opener — tap 5x */}
            <TouchableOpacity
              onPress={onVersionTap}
              activeOpacity={1}
              style={{ paddingVertical: Spacing.lg, alignItems: 'center' }}
            >
              <Text style={{ fontSize: FontSizes.xs, color: colors.textSecondary }}>
                Harvest · v1.0.0
              </Text>
            </TouchableOpacity>

          </ScrollView>
        )}
      </SafeAreaView>

      {/* Hidden debug-log viewer */}
      <Modal visible={debugLogVisible} animationType="slide" onRequestClose={() => setDebugLogVisible(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: Spacing.md, gap: Spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <TouchableOpacity onPress={() => setDebugLogVisible(false)}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ flex: 1, fontSize: FontSizes.md, fontFamily: Fonts.medium, color: colors.text }}>
              Debug log ({debugLogEntries.length})
            </Text>
            <TouchableOpacity onPress={onCopyLog} style={{ paddingHorizontal: Spacing.sm }}>
              <Text style={{ color: colors.primary, fontFamily: Fonts.medium }}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClearLog} style={{ paddingHorizontal: Spacing.sm }}>
              <Text style={{ color: colors.error, fontFamily: Fonts.medium }}>Clear</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1, padding: Spacing.md }}>
            {debugLogEntries.length === 0 ? (
              <Text style={{ color: colors.textSecondary, fontSize: FontSizes.sm }}>No log entries.</Text>
            ) : (
              debugLogEntries.map((e, i) => (
                <View key={i} style={{ marginBottom: Spacing.sm, paddingBottom: Spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <Text style={{ fontSize: FontSizes.xs, color: colors.textSecondary }}>
                    {new Date(e.ts).toLocaleTimeString()} · {e.level.toUpperCase()} · {e.tag}
                  </Text>
                  <Text selectable style={{ fontSize: FontSizes.xs, color: colors.text, fontFamily: Fonts.regular, marginTop: 2 }}>
                    {e.msg}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const makeStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeBtn: {
    width: 44,
    alignItems: 'flex-start',
  },
  title: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.bold,
    color: colors.text,
  },
  saveBtn: {
    width: 44,
    alignItems: 'flex-end',
  },
  saveBtnText: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.semibold,
    color: colors.primary,
  },

  // Loading
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Scroll content
  scroll: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.huge,
  },

  // Section headers
  sectionTitle: {
    fontSize: FontSizes.md,
    fontFamily: Fonts.bold,
    color: colors.text,
    marginBottom: Spacing.xs,
  },
  sectionHint: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: colors.textSecondary,
    marginBottom: Spacing.md,
  },
  subSectionLabel: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    color: colors.textSecondary,
    marginBottom: Spacing.sm,
  },

  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: Spacing.xl,
  },

  // Source rows
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  sourceLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flex: 1,
  },
  sourceName: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
    color: colors.text,
  },
  disabledText: {
    color: colors.textTertiary,
  },

  // Weight chips
  weightChips: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  disabledChips: {
    opacity: 0.35,
  },
  weightChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  weightChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  weightChipDisabled: {
    borderColor: colors.border,
    backgroundColor: colors.borderLight,
  },
  weightChipText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    color: colors.textSecondary,
  },
  weightChipTextActive: {
    color: colors.primary,
  },

  // Ingredient / seed chips
  ingredientGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  ingredientChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  ingredientChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  ingredientChipText: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
    color: colors.textSecondary,
  },
  ingredientChipTextActive: {
    color: colors.primary,
  },

  // Seed chips (teal/green accent to distinguish from weight chips)
  seedChipActive: {
    borderColor: '#059669',
    backgroundColor: '#D1FAE5',
  },
  seedChipTextActive: {
    color: '#065F46',
  },
  seedCountHint: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: '#065F46',
    marginTop: Spacing.sm,
    lineHeight: 18,
  },

  // Kid Friendly — allowed (struck-through look via muted style)
  allowedChip: {
    borderColor: colors.border,
    backgroundColor: colors.borderLight,
    opacity: 0.5,
  },
  allowedChipText: {
    color: colors.textTertiary,
  },

  // Kid Friendly — custom blocked terms
  customBlockChip: {
    borderColor: '#EF4444',
    backgroundColor: '#FEF2F2',
  },
  customBlockChipText: {
    color: '#B91C1C',
  },

  // Add custom term row
  addTermRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  addTermInput: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSizes.sm,
    fontFamily: Fonts.regular,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  // Meal reminders
  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
  },
  reminderTextWrap: {
    flex: 1,
  },
  reminderTitle: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
    color: colors.text,
  },
  reminderSubtitle: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: colors.textSecondary,
    marginTop: 2,
  },
  timeInput: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minWidth: 90,
    textAlign: 'center',
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  timeInputInvalid: {
    borderColor: colors.error,
  },
  helperError: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: colors.error,
    marginTop: Spacing.xs,
  },

  addTermBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryLight,
  },
  servingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.xs,
    marginBottom: Spacing.md,
  },
  servingCounter: {
    flex: 1,
    alignItems: 'center',
  },
  servingLabel: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    color: colors.text,
    marginBottom: Spacing.sm,
  },
  counterControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  counterBtn: {
    padding: Spacing.xs,
  },
  counterValue: {
    fontSize: FontSizes.lg,
    fontFamily: Fonts.bold,
    color: colors.text,
    minWidth: 24,
    textAlign: 'center',
  },
  servingDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.borderLight,
    marginHorizontal: Spacing.md,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  toggleTextCol: {
    flex: 1,
  },
  toggleLabel: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
    color: colors.text,
    marginBottom: 4,
  },
  toggleDesc: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.regular,
    color: colors.textSecondary,
    lineHeight: 16,
  },
  timePickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: colors.surface,
    minWidth: 90,
    justifyContent: 'center',
  },
  timePickerTriggerText: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.medium,
    color: colors.text,
  },
});
