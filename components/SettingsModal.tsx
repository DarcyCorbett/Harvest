// ============================================================
// Meal Wizard — Settings Modal
// Per-household generation settings: source weights + ingredient weights.
// ============================================================

import { Colors, FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import {
  getHouseholdSettings,
  saveHouseholdSettings,
} from '@/services/firestoreService';
import { SEED_INGREDIENT_OPTIONS, TRUSTED_SITES } from '@/services/recipeScraperService';
import type { HouseholdSettings } from '@/services/types';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const colors = Colors.light;

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

export default function SettingsModal({
  visible,
  onClose,
  householdId,
  onSaved,
}: SettingsModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sourceWeights, setSourceWeights] = useState<Record<string, number>>({});
  const [ingredientWeights, setIngredientWeights] = useState<Record<string, number>>({});

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
        // Disable — store last non-zero weight
        setLastNonZeroSource((lnz) => ({ ...lnz, [site]: current }));
        return { ...prev, [site]: 0 };
      } else {
        // Re-enable — restore last non-zero or default to 1
        const restore = lastNonZeroSource[site] ?? 1;
        return { ...prev, [site]: restore };
      }
    });
  }, [lastNonZeroSource]);

  const setSourceWeight = useCallback((site: string, w: number) => {
    setSourceWeights((prev) => ({ ...prev, [site]: w }));
    setLastNonZeroSource((lnz) => ({ ...lnz, [site]: w }));
  }, []);

  // ── Ingredient helpers ─────────────────────────────────────

  const getIngredientWeight = (name: string): number =>
    ingredientWeights[name] ?? 1;

  const cycleIngredientWeight = useCallback((name: string) => {
    setIngredientWeights((prev) => {
      const current = prev[name] ?? 1;
      const next = current >= 3 ? 1 : current + 1;
      return { ...prev, [name]: next };
    });
  }, []);

  // ── Save ──────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await saveHouseholdSettings(householdId, { sourceWeights, ingredientWeights });
      onSaved();
      onClose();
    } catch (err) {
      console.error('[SettingsModal] save failed:', err);
      Alert.alert('Error', `Could not save settings.\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [householdId, sourceWeights, ingredientWeights, onSaved, onClose]);

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

            {/* ── Ingredient Seeds ── */}
            <Text style={styles.sectionTitle}>Ingredient Weights</Text>
            <Text style={styles.sectionHint}>
              Tap a chip to cycle its weight (1× → 2× → 3×). Higher weight means that ingredient appears more often.
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
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create({
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
    borderBottomColor: '#E5E7EB',
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

  divider: {
    height: 1,
    backgroundColor: '#E5E7EB',
    marginVertical: Spacing.xl,
  },

  // Source rows
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
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
    borderColor: '#D1D5DB',
    backgroundColor: colors.surface,
  },
  weightChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  weightChipDisabled: {
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  },
  weightChipText: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    color: colors.textSecondary,
  },
  weightChipTextActive: {
    color: colors.primary,
  },

  // Ingredient chips
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
    borderColor: '#D1D5DB',
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
});
