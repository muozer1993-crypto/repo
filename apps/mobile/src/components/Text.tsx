import {
  Text as RNText,
  type TextProps as RNTextProps,
  StyleSheet,
  type TextStyle,
} from 'react-native';

import { Colors, FontSize, FontWeight } from '@/theme';

export type TextVariant =
  | 'giant'
  | 'huge'
  | 'big'
  | 'title'
  | 'lead'
  | 'body'
  | 'small'
  | 'tiny'
  | 'micro'
  | 'label';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  color?: string;
  muted?: boolean;
  faint?: boolean;
  bold?: boolean;
  black?: boolean;
  center?: boolean;
  upper?: boolean;
}

/**
 * A caller that bumps `fontSize` inherits the variant's `lineHeight`, and a big
 * glyph in a small line box gets its top and bottom sliced off — which is how a
 * 36px invite code ended up rendering inside `body`'s 22px line. Turkish makes
 * it worse: İ, Ğ and Ş carry marks past the cap height, so they go first.
 *
 * So when a style sets fontSize and says nothing about lineHeight, give it one
 * that fits.
 */
function fittedLineHeight(style: TextProps['style']): TextStyle | null {
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  if (!flat || typeof flat.fontSize !== 'number' || flat.lineHeight !== undefined) return null;
  return { lineHeight: Math.round(flat.fontSize * 1.25) };
}

export function Text({
  variant = 'body',
  color,
  muted,
  faint,
  bold,
  black,
  center,
  upper,
  style,
  ...rest
}: TextProps) {
  return (
    <RNText
      {...rest}
      style={[
        styles.base,
        styles[variant],
        fittedLineHeight(style),
        muted && { color: Colors.textMuted },
        faint && { color: Colors.textFaint },
        bold && { fontWeight: FontWeight.bold },
        black && { fontWeight: FontWeight.black },
        center && { textAlign: 'center' },
        upper && { textTransform: 'uppercase' },
        color ? { color } : null,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    color: Colors.text,
  },
  giant: { fontSize: FontSize.giant, fontWeight: FontWeight.black, letterSpacing: -1.5, lineHeight: FontSize.giant * 1.18 },
  huge: { fontSize: FontSize.huge, fontWeight: FontWeight.black, letterSpacing: -1, lineHeight: FontSize.huge * 1.2 },
  big: { fontSize: FontSize.big, fontWeight: FontWeight.black, letterSpacing: -0.6, lineHeight: FontSize.big * 1.22 },
  title: { fontSize: FontSize.title, fontWeight: FontWeight.bold, letterSpacing: -0.3, lineHeight: FontSize.title * 1.25 },
  lead: { fontSize: FontSize.lead, fontWeight: FontWeight.semibold, lineHeight: FontSize.lead * 1.35 },
  body: { fontSize: FontSize.body, fontWeight: FontWeight.regular, lineHeight: FontSize.body * 1.4 },
  small: { fontSize: FontSize.small, fontWeight: FontWeight.regular, lineHeight: FontSize.small * 1.4 },
  tiny: { fontSize: FontSize.tiny, fontWeight: FontWeight.medium, lineHeight: FontSize.tiny * 1.35 },
  micro: { fontSize: FontSize.micro, fontWeight: FontWeight.semibold, lineHeight: FontSize.micro * 1.3 },
  label: {
    fontSize: FontSize.micro,
    fontWeight: FontWeight.black,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: Colors.textMuted,
  },
});
