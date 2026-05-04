# Sheer Lab

Shared salon tablet app for V1 basin workflows: device binding, salon-scoped stylist PIN login,
formula capture, product usage tracking, BLE scale status, and billing handoff.

## Architecture notes

- This is a separate Expo app from `apps/mobile`; `apps/mobile` remains the personal Sheer App.
- Stylist PIN login is scoped by `salonId + pin`. A PIN must never be looked up globally.
- Device binding is persisted locally so a bound tablet skips setup on the next launch.
- BLE scale code is intentionally contained under `src/ble` in this app.
- Pure formula/session logic can move into packages later if V2 brings Sheer Lab flows into the
  personal app, but V1 keeps the app boundary explicit.

## Commands

```bash
pnpm --filter @sheer/sheer-lab start
pnpm --filter @sheer/sheer-lab lint
pnpm --filter @sheer/sheer-lab typecheck
```
