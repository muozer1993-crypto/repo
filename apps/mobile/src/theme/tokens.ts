/**
 * KOYDUM visual language: dark, loud, neon. Everything is built from these tokens.
 */
export const Colors = {
  /** page background */
  bg: '#0B0B0F',
  /** cards, sheets */
  surface: '#16161D',
  /** raised surface / pressed state */
  surfaceHigh: '#1F1F29',
  /** hairlines */
  border: '#2A2A36',
  /** the brand pink — CTAs, winner, shame */
  accent: '#FF3D71',
  accentDim: '#7A1B34',
  /** secondary highlight — scores, streaks */
  yellow: '#FFD400',
  yellowDim: '#6B5900',
  success: '#2EE59D',
  successDim: '#12513A',
  danger: '#FF4D4D',
  dangerDim: '#5C1B1B',
  info: '#4D9BFF',
  text: '#F5F5F7',
  textMuted: '#9A9AA5',
  textFaint: '#5F5F6B',
  black: '#000000',
  white: '#FFFFFF',
  /** translucent overlays */
  scrim: 'rgba(0,0,0,0.72)',
} as const;

export type ColorKey = keyof typeof Colors;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const Radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const FontSize = {
  micro: 11,
  tiny: 12,
  small: 14,
  body: 16,
  lead: 18,
  title: 22,
  big: 28,
  huge: 36,
  giant: 52,
} as const;

export const FontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  black: '900',
} as const;

/** Shadow presets that work on both platforms (RN maps elevation on Android). */
export const Shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  glowAccent: {
    shadowColor: Colors.accent,
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
} as const;

export const Layout = {
  maxWidth: 640,
  tabBarHeight: 62,
  headerHeight: 56,
} as const;
