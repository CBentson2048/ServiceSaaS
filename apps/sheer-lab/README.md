# Sheer Lab

Sheer Lab is a separate React Native CLI app for BLE-sensitive, staff-facing salon workflows:
scale pairing, live weight capture, manual fallback, and formula capture.

`apps/sheer-app` remains the existing Expo app. Sheer Lab uses the same backend, auth model, and
shared contracts through packages such as `@sheer/domain`, `@sheer/api-client`, and
`@sheer/lab-core`; it should not grow a separate business logic universe.

## Scaffolded Now

- React Native CLI entry with generated `ios/` and `android/` projects.
- Minimal native-stack navigation for Auth, Home, Device Pairing, Formula, Formula History, and Settings.
- Dark staff-facing theme foundation using shared design tokens.
- API/auth/storage/logging shells wired to shared packages.
- BLE feature shell with native permissions/placeholders, but no hardware integration yet.

## Next Work

- Install and wire the selected BLE native library.
- Implement Acaia Pearl scan/connect/reconnect/live-weight subscription.
- Replace in-memory session storage with secure native storage.
- Add real Sheer Lab auth/session handling and the formula capture workflow.

## Commands

```bash
pnpm install
pnpm --filter @sheer/sheer-lab start
pnpm --filter @sheer/sheer-lab ios
pnpm --filter @sheer/sheer-lab android
pnpm --filter @sheer/sheer-lab typecheck
```
