# Database Notes: Lab Auth

## `core.shared_devices`

Stores registered shared tablets for salon/location workflows. For V1 this is the Sheer Lab iPad.
The table tracks device name, type, station label, app mode, status, registration time, and last
seen time.

## `core.stylist_pin_credentials`

Stores hashed PIN credentials for owners, managers, and stylists. Raw PINs must never be stored.
Active PIN hashes are unique per business/location, which allows the same 4-digit PIN to exist in a
different salon.

## `lab.device_pairings`

Stores BLE scale pairing state for a shared device. The active pairing index keeps one current scale
relationship per device while retaining historical rows for audit and troubleshooting.

## `lab.formula_sessions`

Tracks unlocked Sheer Lab sessions, including device, location, user, role, status, last activity,
expiry, and end reason. The API should update this table through transactional session logic.

## `audit.lab_access_events`

Captures security-relevant Lab activity: unlock attempts, successful unlock, lockout, logout,
device pairing, PIN reset, and other manager/admin actions.

## RLS Direction

The initial migration enables RLS and adds read policies using existing membership helpers. Writes
should flow through the API service role so PIN hashing, lockout, expiry, formula save, inventory,
billing handoff, and audit writes remain consistent.
