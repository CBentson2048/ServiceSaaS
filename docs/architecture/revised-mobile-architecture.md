# Revised Mobile Architecture

## V1 App Split

Sheer V1 now has two mobile surfaces:

- `apps/sheer-app` is the personal stylist phone app.
- `apps/sheer-lab` is the shared salon iPad app used near the basin.

The split exists because the two apps have different trust, session, and hardware models. The
personal Sheer App uses normal user authentication and focuses on dashboard, bookings, rota,
performance, and commissions. The Sheer Lab App runs on a shared location device and unlocks by a
salon-scoped 4-digit PIN.

## BLE Boundary

BLE scale integration belongs only in `apps/sheer-lab` for V1. The scale is tied to the salon iPad,
the location, and the basin workflow. Keeping BLE out of `apps/sheer-app` avoids adding hardware
permissions and shared-device assumptions to each stylist's personal phone app.

## Shared-Device PIN Auth

Sheer Lab PIN auth is distinct from personal auth:

- The device is already salon/location-scoped.
- The stylist enters only a 4-digit PIN.
- The stylist does not select an identity first.
- PIN uniqueness is enforced per salon/location only.
- The same PIN may exist in another salon.
- PINs are stored hashed, never plaintext.

Manager/owner users assign and reset PINs. Managers can access all location Lab operations.

## V2 Reuse Path

Reusable Lab logic lives in `packages/lab-core`. A future solo/freelancer V2 can embed Lab workflows
inside the personal Sheer App by consuming `lab-core` and shared UI/contracts without moving BLE or
shared-device assumptions into the V1 phone app.
