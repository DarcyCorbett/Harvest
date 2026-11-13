import React from 'react';
import { Pressable, Text } from 'react-native';
import Sheet from './Drawer';
import { useTheme } from '@/contexts/ThemeContext';
import { Fonts } from '@/constants/theme';

export default function ShoppingChoice({ choose }: { choose: (choice: 'keep' | 'replace' | null) => void }) {
  const { colors } = useTheme();
  const option = (label: string, value: 'keep' | 'replace' | null) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => choose(value)} style={{ minHeight: 48, padding: 14, borderRadius: 24, backgroundColor: value === 'keep' ? colors.primary : colors.surface }}><Text style={{ fontFamily: Fonts.semibold, textAlign: 'center', color: value === 'keep' ? colors.textInverse : colors.text }}>{label}</Text></Pressable>;
  return <Sheet title="Update shopping list" onClose={() => choose(null)}>
    <Text style={{ color: colors.textSecondary, fontFamily: Fonts.regular, lineHeight: 22 }}>Keep your existing items and add these ingredients, or replace the whole list? Replacing also clears manual and purchased items.</Text>
    {option('Keep existing items', 'keep')}
    {option('Replace list', 'replace')}
    {option('Cancel', null)}
  </Sheet>;
}
