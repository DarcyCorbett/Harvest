import { Colors } from '@/constants/theme';
import { useTheme } from '@/contexts/ThemeContext';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const { effectiveScheme } = useTheme();
  return props[effectiveScheme] ?? Colors[effectiveScheme][colorName];
}
