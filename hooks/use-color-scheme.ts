import { useTheme } from '@/contexts/ThemeContext';

export function useColorScheme(): 'light' | 'dark' {
  return useTheme().effectiveScheme;
}
