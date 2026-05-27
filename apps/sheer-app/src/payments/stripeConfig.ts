export const STRIPE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
export const STRIPE_URL_SCHEME = 'qlooqo';

export function isStripeConfigured(): boolean {
  return STRIPE_PUBLISHABLE_KEY.trim().length > 0;
}
