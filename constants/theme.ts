/**
 * Meal Wizard — Design System
 * Theme tokens for light and dark modes.
 */

import { Platform } from 'react-native';

// ─── Color Palette ───────────────────────────────────────────
// Primary: consistent forest green across light and dark modes
// Accent: warm amber — feels like home cooking
// Surfaces: carefully tuned grays for depth

export const Colors = {
  light: {
    // Core
    primary: '#047857',        // accessible green with white button text
    primaryLight: '#D1FAE5',   // soft green tint
    primaryDark: '#047857',
    accent: '#F59E0B',         // warm amber
    accentLight: '#FEF3C7',    // buttery warm tint

    // Surfaces
    background: '#FDFBF7',     // warm, airy beige/cream
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    card: '#FFFFFF',

    // Text
    text: '#1C1917',           // stone-900
    textSecondary: '#78716C',  // stone-500
    textTertiary: '#706A65',
    textInverse: '#FFFFFF',

    // Borders & dividers
    border: '#F5F5F4',         // extremely soft border
    borderLight: '#FAFAF9',
    divider: '#F5F5F4',

    // Semantic
    success: '#047857',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#3B82F6',

    // Tab bar
    tabBar: '#FFFFFF',
    tabBarBorder: 'transparent', // floaty feel
    tabIconDefault: '#A8A29E',
    tabIconSelected: '#047857',

    // Pastel UI Theme Elements
    caloriesBadge: '#FEF0B6',  // pastel butter
    caloriesText: '#B45309',
    proteinBadge: '#D1FAE5',   // pastel sage/mint
    proteinText: '#047857',
    carbsBadge: '#DBEAFE',     // pastel sky
    carbsText: '#1D4ED8',
    fatBadge: '#FCE7F3',       // pastel pink
    fatText: '#BE185D',

    // Misc
    shadow: 'rgba(28, 25, 23, 0.04)', // extremely diffuse, soft ambient shadow
    overlay: 'rgba(0, 0, 0, 0.4)',
    placeholder: '#D6D3D1',
    inputBackground: '#FDFBF7',
    checked: '#A8A29E',
  },
  dark: {
    // Core
    primary: '#047857',        // forest green with white button text
    primaryLight: '#064E3B',   // deep green tint
    primaryDark: '#047857',
    accent: '#FBBF24',
    accentLight: '#78350F',

    // Surfaces
    background: '#1C1917',     // soft stone dark (not pitch black)
    surface: '#292524',        // stone-800
    surfaceElevated: '#44403C',// stone-700
    card: '#292524',

    // Text
    text: '#FAFAF9',           // stone-50
    textSecondary: '#A8A29E',  // stone-400
    textTertiary: '#B3ABA5',
    textInverse: '#FFFFFF',

    // Borders & dividers
    border: '#44403C',         // soft separation
    borderLight: '#292524',
    divider: '#44403C',

    // Semantic
    success: '#047857',
    warning: '#FBBF24',
    error: '#F87171',
    info: '#60A5FA',

    // Tab bar
    tabBar: '#1C1917',
    tabBarBorder: '#292524',
    tabIconDefault: '#78716C',
    tabIconSelected: '#047857',

    // Pastel UI Theme Elements (adapted for dark mode readability)
    caloriesBadge: '#78350F',
    caloriesText: '#FDE68A',
    proteinBadge: '#064E3B',
    proteinText: '#A7F3D0',
    carbsBadge: '#1E3A8A',
    carbsText: '#BFDBFE',
    fatBadge: '#831843',
    fatText: '#FBCFE8',

    // Misc
    shadow: 'rgba(0, 0, 0, 0.4)', // harsher shadows needed in dark mode
    overlay: 'rgba(0, 0, 0, 0.7)',
    placeholder: '#57534E',
    inputBackground: '#292524',
    checked: '#44403C',
  },
};

// ─── Typography ──────────────────────────────────────────────
// The app relies heavily on the Outfit geometric font for the modern
// squircle aesthetic. Fallbacks are system sans-serifs.

export const Fonts = {
  regular: 'Outfit_400Regular',
  medium: 'Outfit_500Medium',
  semibold: 'Outfit_600SemiBold',
  bold: 'Outfit_700Bold',
};

export const FontSizes = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  xxxl: 36,
  hero: 48,
};

export const FontWeights = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
};

// ─── Spacing ─────────────────────────────────────────────────

export const Spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  huge: 56,
  massive: 72,
};

// ─── Border Radius ───────────────────────────────────────────
// The signature of this app's design is extreme rounding.

export const Radius = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  massive: 48,
  pill: 9999,
};

// ─── Shadows ─────────────────────────────────────────────────
// Extremely soft, diffuse, tinted shadows representing ambient light
// rather than harsh spotlights.

export const Shadows = {
  sm: {
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 4,
  },
  lg: {
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.07,
    shadowRadius: 24,
    elevation: 8,
  },
};
