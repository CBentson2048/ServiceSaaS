/**
 * Shadow tokens.
 *
 * React Native and web use different shadow models, so each token exposes
 * both representations.
 *  - `web` is a CSS box-shadow string
 *  - `native` is the RN view-style fragment (shadow* + elevation)
 */
export interface ShadowToken {
  web: string;
  native: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
  };
}

const inkShadow = '#2B1927';

export const shadow = {
  none: {
    web: 'none',
    native: {
      shadowColor: 'transparent',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0,
      shadowRadius: 0,
      elevation: 0,
    },
  },
  card: {
    web: '0 1px 2px rgba(43,25,39,0.04), 0 5px 16px rgba(43,25,39,0.055)',
    native: {
      shadowColor: inkShadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 4,
      elevation: 2,
    },
  },
  hero: {
    web: '0 8px 24px rgba(43,25,39,0.08), 0 18px 50px rgba(43,25,39,0.06)',
    native: {
      shadowColor: inkShadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 6,
    },
  },
  modal: {
    web: '0 18px 45px rgba(43,25,39,0.16), 0 32px 90px rgba(43,25,39,0.14)',
    native: {
      shadowColor: inkShadow,
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.18,
      shadowRadius: 24,
      elevation: 12,
    },
  },
} as const satisfies Record<string, ShadowToken>;

export type ShadowName = keyof typeof shadow;
