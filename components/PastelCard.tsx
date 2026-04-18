import { Colors, Fonts, FontSizes, Radius, Spacing } from '@/constants/theme';
import React from 'react';
import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const { width } = Dimensions.get('window');
// Default: 3-column grid with xl-sized gutters — slightly smaller than before
const DEFAULT_CARD_W = (width - Spacing.xl * 2 - Spacing.xl * 2) / 3;

interface Props {
  title: string;
  emoji: string;
  selected?: boolean;
  onPress?: () => void;
  baseColorHex?: string;
  selectedColorHex?: string;
  /** Override the card width — use this when you want a different column count */
  cardWidth?: number;
}

export default function PastelCard({
  title,
  emoji,
  selected = false,
  onPress,
  baseColorHex,
  selectedColorHex,
  cardWidth,
}: Props) {
  // Always light — PastelCard is only used in the forced-light Generate tab.
  const colors = Colors.light;

  const cardW = cardWidth ?? DEFAULT_CARD_W;

  const bg = selected
    ? (selectedColorHex || colors.caloriesBadge)
    : (baseColorHex || colors.surface);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        styles.card,
        { backgroundColor: bg, width: cardW, height: cardW * 0.95 },
        selected ? { borderColor: colors.primary } : { borderColor: '#D1D5DB' },
      ]}
    >
      <View style={[
        styles.emojiContainer,
        selected && { backgroundColor: colors.surface },
      ]}>
        <Text style={styles.emoji}>{emoji}</Text>
      </View>
      <Text
        style={[styles.title, { color: colors.text }]}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {title}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xxl,
    padding: Spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  emojiContainer: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  emoji: {
    fontSize: 30,
  },
  title: {
    fontFamily: Fonts.medium,
    fontSize: FontSizes.xs,
    textAlign: 'center',
    lineHeight: 16,
  },
});
