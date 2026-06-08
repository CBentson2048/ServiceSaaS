export const STRIPE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
export const STRIPE_URL_SCHEME = 'qlooqo';

// Apple Pay merchant identifier. Must match the value in the @stripe/stripe-react-native
// config plugin (app.json) and the Apple Pay merchant ID registered in the Apple Developer
// account. Override per build via EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER.
export const STRIPE_MERCHANT_IDENTIFIER =
  process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER ?? 'merchant.com.qlooqo.app';

// Two-letter ISO country of the business, used as the Apple Pay merchant country
// when a booking location does not carry its own country code.
export const STRIPE_DEFAULT_MERCHANT_COUNTRY = 'GB';

export function isStripeConfigured(): boolean {
  return STRIPE_PUBLISHABLE_KEY.trim().length > 0;
}
