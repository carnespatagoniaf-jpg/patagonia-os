# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Patagonia OS — an ERP for "Carnes Patagonia" (a meat retailer). npm workspaces monorepo, currently at v3.1.2. Documentation and code comments are written in Spanish; match that when editing docs, SQL comments, or user-facing strings.

## Commands

Run from the repo root (npm workspaces, Node >= 20):

```bash
npm install
npm run dev         # runs @patagonia/web (vite) only
npm run build        # builds domain -> web -> api, in that order
npm run test          # runs @patagonia/domain tests only (node --test)
npm run typecheck    # typechecks web and api
npm run lint          # lints web only
```

To work on a single workspace, use `-w`, e.g. `npm run dev -w @patagonia/api` (runs `tsx src/server.ts`, default port 8787). `@patagonia/domain` has no dev/lint script; its `build` (`tsc -p tsconfig.json`) must run before its `test` script, since tests run against compiled output in `dist/`, not source.

There is no root-level test runner beyond the domain package; `apps/web` and `apps/api` have no test scripts defined.

## Architecture

Three workspaces plus a Supabase backend:

- `apps/web` (`@patagonia/web`): React + TypeScript + Vite frontend. This is the primary UI and the only workspace with a `dev` script wired into the root `npm run dev`.
- `apps/api` (`@patagonia/api`): Express + TypeScript API, intended for logic too sensitive for the client. Currently minimal — `apps/api/src/modules/sales/router.ts` only validates payloads with zod and returns `501`; the real sale-processing path is a Supabase RPC called directly from the frontend (see below), not this API.
- `packages/domain` (`@patagonia/domain`): framework-free shared types and pure business logic (`Product`, `CartItem`, cart totals, profit calculation, `assertSellable` stock guard). Both `web` and `api` depend on it. Compile it (`npm run build -w @patagonia/domain`) before consumers can pick up changes, since they import from `dist/`, not `src/`.
- `supabase/migrations`: numbered SQL migrations, must be run **in order** (001 → 004) against a Supabase Postgres project — see `docs/SUPABASE_SETUP_V31.md`. `supabase/seed` has demo data and an owner-profile bootstrap script.

### Core domain model (multi-company, multi-branch)

Every table hangs off `company_id` (and most off `branch_id`): `companies` → `branches` → `profiles` (linked 1:1 to `auth.users`, carries `role`) → `products`, `inventory_movements`, `cash_sessions`, `sales`/`sale_items`, `cash_movements`, `audit_log`.

Key invariants (see `docs/ARCHITECTURE.md`):
- Stock is never stored/edited directly — it is always the sum of `inventory_movements` rows (see the `current_stock` view and `products_with_stock` view in the migrations).
- Sensitive writes (a sale) run inside a single Postgres transaction via the `create_sale_transaction` SQL function (`supabase/migrations/003_auth_and_sale_transaction.sql`), which: checks the caller's profile/company, locks the open cash session for the branch, locks and validates stock per product, inserts the sale + sale_items, writes compensating `inventory_movements`, writes a `cash_movements` entry, and writes to `audit_log` — all-or-nothing. The frontend calls this via `supabase.rpc("create_sale_transaction", ...)` in `apps/web/src/features/pos/sales-service.ts`, bypassing the Express API entirely for this flow.
- Row Level Security is enabled on every business table (`supabase/migrations/002_security.sql`, extended in `004_security_complete.sql`). Isolation is enforced via a `current_company_id()` SQL function that reads the caller's `profiles` row, used in `using (company_id = current_company_id())` policies. Never assume the client can be trusted to filter by company/branch — RLS is the actual boundary.
- Secrets: `VITE_*`-prefixed env vars are shipped to the browser; `SUPABASE_SERVICE_ROLE_KEY` must never be given a `VITE_` prefix or referenced from `apps/web`.

### Frontend structure (`apps/web/src`)

- `lib/supabase.ts` exports a nullable `supabase` client and `isSupabaseConfigured` — most of the app checks this flag to fall back to a local "demo mode" (see `lib/demo-data.ts`) when Supabase env vars are absent. `App.tsx` uses this flag to decide whether to require login at all.
- `features/auth`: `AuthProvider.tsx` owns session/profile state (fetches the `profiles` row after login, signs the user back out if the profile is missing/inactive); `permissions.ts` defines a static `role -> Permission[]` map and the `can(profile, permission)` check consumed by feature components.
- `features/pos`, `features/inventory`, `features/purchases`, `features/dashboard`: one feature folder per page, matching `Layout.tsx`'s nav items. Note `Pos.tsx` currently operates on local demo state (`demoProducts`, in-memory cart/stock mutation) — it does not yet call `sales-service.ts`'s `createSaleCloud`, so the UI and the transactional backend path are not yet wired together end-to-end.
- Feature-local `*-service.ts` files (`sales-service.ts`, `inventory-service.ts`) are the intended integration points with Supabase (RPC calls / table reads); keep Supabase-specific query/RPC code there rather than inside components.

## Deployment

Netlify, per `netlify.toml` / `docs/DEPLOY.md`: build command `npm run build`, publish directory `apps/web/dist`. Requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set in Netlify env; `/api/*` is redirected to Netlify functions (not the `apps/api` Express server, which isn't currently deployed by this config).
