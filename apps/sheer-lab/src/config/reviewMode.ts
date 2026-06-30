import type { LabDeviceResolveResponse } from '@sheer/domain';

/**
 * ===========================================================================
 *  APP STORE REVIEW MODE — TEMPORARY. REMOVE BEFORE A PRODUCTION RELEASE.
 * ===========================================================================
 *
 * Lets an App Store reviewer skip the one-time device-registration *token*
 * step on the Device Registration screen and jump straight to the PIN screen
 * for the Kensington location only. The reviewer STILL has to enter a valid
 * Kensington stylist PIN to actually sign in — this bypasses nothing except the
 * device-token gate, and it is scoped to a single location (Kensington).
 *
 * HOW IT IS WIRED (every touch point is guarded by REVIEW_MODE_ENABLED and
 * tagged with the string "REVIEW MODE" so it is easy to grep + delete):
 *   1. DeviceRegistrationScreen renders a "Review mode" button.
 *   2. Tapping it calls enterReviewMode() on DeviceSessionProvider, which swaps
 *      in the synthetic Kensington device context below and routes to the PIN
 *      screen (the normal "ready" device flow).
 *   3. AuthScreen unlocks against the REAL backend using the Kensington device
 *      + location ids, so a real Kensington PIN is required to proceed.
 *
 * TO REMOVE FOR PRODUCTION:
 *   • Kill switch: set REVIEW_MODE_ENABLED = false (the button disappears and
 *     every review-mode path becomes unreachable dead code).
 *   • Full removal: delete this file, then delete the two guarded call sites
 *     that import it (grep for "REVIEW MODE"):
 *       - src/features/sheer-lab/DeviceSessionProvider.tsx
 *       - src/screens/DeviceRegistration/DeviceRegistrationScreen.tsx
 *
 * BEFORE SUBMITTING: fill the three ids below with the REAL production values
 * for the Kensington location, a shared device already registered to it, and
 * make sure a Kensington stylist PIN credential exists — otherwise the backend
 * will reject the unlock.
 */

/** Master switch. `true` while the build is in App Store review; `false`/deleted for production. */
export const REVIEW_MODE_ENABLED = true;

// --- Real production identifiers for the Kensington location ----------------
// These MUST resolve to real rows in production (core.locations,
// core.shared_devices) or the PIN unlock will be rejected.
const KENSINGTON_LOCATION_ID = 'a8572daf-e782-4102-ba8f-f5d31a181bfc';
const KENSINGTON_BUSINESS_ID = 'b793790e-146f-488b-be86-c6f0abf6f1bd';
const KENSINGTON_SHARED_DEVICE_ID = 'f40bbb2c-3946-4628-a5ba-161dc74da3a4';
const KENSINGTON_LOCATION_NAME = 'Kensington';

/**
 * Synthetic device context handed to the app as if this iPad were registered to
 * Kensington. Only the ids + location name are load-bearing (they drive the PIN
 * unlock); the remaining fields are cosmetic.
 */
export function buildKensingtonReviewContext(): LabDeviceResolveResponse {
  return {
    device: {
      id: KENSINGTON_SHARED_DEVICE_ID,
      businessId: KENSINGTON_BUSINESS_ID,
      locationId: KENSINGTON_LOCATION_ID,
      deviceName: 'App Review iPad',
      deviceType: 'ipad',
      appMode: 'sheer_lab',
      status: 'active',
      registeredAt: '2024-01-01T00:00:00.000Z',
    },
    location: {
      id: KENSINGTON_LOCATION_ID,
      name: KENSINGTON_LOCATION_NAME,
    },
  };
}
