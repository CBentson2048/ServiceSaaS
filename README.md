# Sheer Platform

Multi-location salon operations platform covering booking, CRM, rota, Sheer Lab (BLE formula workflows), commission, and reporting across mobile, web, and backend services.

This repository is a **pnpm + TurboRepo monorepo**. All apps and shared packages live together and share common tooling, types, and lint/format rules.

## Monorepo structure

```
.
├── apps
│   ├── mobile   # Expo React Native app (staff + client experiences)
│   ├── web      # Vite + React dashboard (owner/manager)
│   └── api      # NestJS backend API
├── packages
│   ├── config   # Shared ESLint / tsconfig helpers
│   ├── types    # Shared domain types
│   └── utils    # Shared utilities (formatters, className helper, etc.)
├── database
│   ├── schema     # SQL / Supabase schema definitions
│   ├── migrations # Ordered migration files
│   ├── policies   # RLS / access policies
│   └── seeds      # Seed data for dev / staging
├── docs
│   └── architecture
└── .github/workflows
```

## Apps

- **apps/mobile** — Expo + TypeScript app using Expo Router. Entry point for stylists and clients (booking, check-in, Sheer Lab BLE formula workflows).
- **apps/web** — Vite + React + TypeScript + React Router + Tailwind CSS. Owner/manager dashboard: bookings, CRM, rota, commission, reporting.
- **apps/api** — NestJS + TypeScript backend. Modular structure ready for auth, booking, CRM, rota, sheer-lab, billing, and commission modules.

## Prerequisites

- Node.js **20 LTS** (`nvm use` will pick up `.nvmrc`)
- **pnpm** 9+ (`npm install -g pnpm`)
- For mobile:
  - [Expo CLI](https://docs.expo.dev/) (runs via `pnpm --filter mobile start`)
  - Xcode (iOS) / Android Studio (Android) if running native builds

## Install

```bash
nvm use
pnpm install
```

## Common commands

Run at the repo root (Turbo fans out to the right workspaces):

```bash
pnpm dev         # run all apps in dev mode
pnpm build       # build everything
pnpm lint        # lint everything
pnpm typecheck   # TypeScript check across the monorepo
pnpm test        # run tests
pnpm format      # Prettier write
```

Run for a single workspace:

```bash
pnpm --filter web dev
pnpm --filter api dev
pnpm --filter mobile start
```

## Build

```bash
pnpm build
```

Turbo caches build artifacts per-package. Individual build outputs:

- `apps/web/dist`
- `apps/api/dist`
- `apps/mobile` — bundled via Expo (`eas build` for production binaries)

## Environments

Three target environments, all configured via `.env` files:

- `development` — local devs, feature branches
- `staging` — pre-production, shared QA
- `production` — live

Each app has its own `.env.example`. Copy to `.env` and fill in locally. The root `.env.example` documents cross-cutting shared service credentials.

## Planned integrations

- **Supabase** — Postgres, auth, storage, realtime. Schema and policies live in `database/`.
- **Stripe** — payments, deposits, subscriptions, connected accounts for tenants.
- **Twilio** — SMS reminders, booking confirmations, transactional messaging.

These are not yet wired; placeholders exist in each app's `.env.example` and the root `.env.example`.

## Conventions

- TypeScript everywhere.
- ESLint + Prettier enforced via CI.
- Shared types live in `packages/types`. Apps import them — don't redefine.
- Shared utils live in `packages/utils`.
- Keep backend modules small and domain-scoped.

## CI

GitHub Actions runs install, lint, typecheck, and build on every pull request and on pushes to `main` / `develop`. See `.github/workflows/ci.yml`.
