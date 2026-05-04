# Sheer Lab Session Flow

## Device Registration

Each salon has a shared Sheer Lab iPad. The app registers a shared device record for a business and
location, then pairs that device with the location scale. Device identity should be trusted by the
API before any PIN unlock is accepted.

## PIN Verification

The locked screen accepts a 4-digit PIN without a stylist selector. The API verifies the PIN against
active hashed credentials scoped by business and location. A PIN match in another location must not
unlock the current device.

## Session Unlock

Successful PIN verification creates a Lab session with:

- shared device ID
- business ID
- location ID
- user profile ID
- role
- last activity timestamp
- expiry timestamp

Stylists land on their own active/today appointments. Managers land on the location-wide Lab
operations view.

## Inactivity Timeout

Lab sessions auto-lock after 10 minutes of inactivity. Activity events include PIN unlock, screen
taps, formula editing, BLE capture, and save actions. The scaffold avoids auto-lock while active
formula interaction is in progress.

## Logout

Manual logout clears local session state and returns the app to the PIN screen. The API should mark
the session ended with a logout reason and record an audit event.

## Manager Capabilities

Managers can view all location Lab activity, pair/unpair the scale, assign/reset PINs, and unbind a
shared device through an admin-gated flow.
