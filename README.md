# Sampolio - Personal Finance Planner

A self-hosted personal finance planning tool that replaces budgeting spreadsheets with a powerful, private workflow. Track multiple accounts, project your financial future, manage debts and investments, reconcile balances, and optionally sync read-only bank data (Enable Banking / PSD2) — all stored locally with AES-256-GCM encryption.

## Features

### Cash Flow Management
- **Multi-Account Support**: Manage multiple financial accounts independently with different currencies (EUR, USD, BRL, GBP, JPY, CHF, CAD, AUD, SEK, NOK, DKK)
- **Recurring Income & Expenses**: Track fixed items (salary, rent, subscriptions) with monthly, quarterly, yearly, or custom interval frequencies
- **Planned Items**: One-off expenses (taxes, annual fees) and repeating non-monthly items (quarterly payments)
- **Occurrence Overrides**: Edit or skip individual occurrences of recurring items without changing the series
- **Salary Calculator**: Net salary computation with gross salary, taxable/non-taxable benefits, tax rate, contributions, and deductions — automatically linked to recurring income
- **Taxed Income**: Handle bonuses, holiday pay, and other special income with tax withholding (using salary settings or custom rates)
- **Category Management**: Built-in categories (Salary, Housing, Utilities, etc.) plus custom categories; remove or restore defaults

### Wealth Management
- **Investments**: Track investment accounts with starting valuations, annual growth rates, and one-off or recurring contributions/withdrawals
- **Debts**: Manage amortized loans (mortgages with fixed/variable interest, reference rates like Euribor) and fixed-installment debts (no interest). Track extra payments and remaining installments
- **Receivables**: Track money owed to you with optional interest rates, expected monthly repayments, and repayment recording

### Shared Mortgage
- **Co-Owned Mortgage Tracking**: Model a household mortgage shared between members (e.g. a couple), with multiple sub-loans, per-loan margins, and Euribor reference rates
- **Auto-Amortization Engine**: Monthly amortization on an actual/360 day count, re-annuitizing the payment at each rate reset to hold the maturity date
- **Ownership & Equity**: Derives each member's stake, liability, and equity from the down payments and house price; equity folds into net worth (no double counting as a debt)
- **Exact Reconciliation**: Reconcile each month from the bank's real figures (or bulk-import history via CSV), so the ledger matches the bank exactly; forecasts carry the current installment forward until the next rate reset
- **Euribor Reminder**: The Overview page flags when a mortgage's yearly Euribor rate is due for an update
- **Cashflow Integration**: Each member can link the mortgage to their own cash account so their share of the monthly charge appears as a read-only line in their projection

### Split (Shared Expenses)
- **Splitwise-Style Groups**: Track shared expenses across groups with other Sampolio users — equal/custom/percentage splits, settle-up suggestions, recurring shared expenses, and an activity feed
- **Splitwise CSV Import**: Migrate an existing Splitwise group by importing its CSV export
- **Bank-Transaction Linking**: Link a split expense to the bank transaction it came from; the bank ledger flags transactions that are "already split"
- **Net-Worth Integration**: Your aggregate split balance folds into the Overview net-worth KPI

### Goals
- **Reserve & Spend Goals**: Track financial targets against an account balance, your net worth, or a manual amount, with on-track/behind/achieved status and a projected reach date
- **Cashflow Injection**: A spend goal with a target date can inject its target amount as a read-only expense line into the linked account's projection
- **Joint Funding Plan**: Prioritized goals competing for the same money are planned jointly, so each goal sees a realistic remainder instead of double-counting the shared pool

### Trips (Per-Diem Calculator)
- **Tax-Exempt Per Diems**: Compute Finnish Tax Administration (Vero.fi) per-diem allowances for business trips day by day, with country-specific rates and free-meal reductions
- **Rate Snapshotting**: Each trip locks in the per-diem rates in effect at creation, so later rate-table changes never alter a planned trip
- **Cashflow Integration**: An unreimbursed trip injects its per-diem total as a read-only income line into the linked account's projection at the expected reimbursement month

### Budgets
- **Trip/Project Budgets**: Plan a bounded-period budget (e.g. a research stay abroad) with one-off and monthly cost lines
- **Grant Funding**: Add funding sources — grants (optionally restricted to specific categories), per-diem allowances, and other income — with automatic allocation and a feasibility verdict (out-of-pocket, surplus)
- **Expense Log**: Record dated actual expenses and track them against the plan
- **CSV Export**: Export a grant report (spending log + summary) as a fi-FI Excel-friendly CSV
- **Cashflow Integration**: A confirmed budget linked to a cash account injects its monthly impact into that account's projection (with manual exchange rate for cross-currency budgets)

### Financial Projections
- **Multi-Year Cash Flow Projections**: See your financial future up to 10 years ahead with instant recalculation across all accounts
- **Net Worth Projection**: Aggregate wealth over time combining cash accounts, investments, receivables, and debts
- **Debt Amortization Schedules**: Automatic calculation with support for variable interest rates and rate reset frequencies
- **Investment Growth Modeling**: Compound monthly growth based on annual rates, incorporating contributions and withdrawals
- **"What If?" Playground**: Explore hypothetical changes (a raise, a new expense, a cancelled subscription, extra savings) and instantly compare the projected balance against your current plan — scenarios are computed on the fly and never saved

### Reconciliation
- **Monthly Balance Verification**: Compare projected vs. actual balances for all entity types (cash, investments, receivables, debts)
- **Variance Tracking**: Calculate and display differences between expected and actual balances
- **Adjustment Categories**: Classify variances as untracked income/expense, valuation change, interest adjustment, data correction, or other
- **Session Management**: Track reconciliation sessions with in-progress and completed states

### Bank Sync (Enable Banking — optional, read-only)
- **Automatic Balances & Transactions**: Connect real bank accounts via [Enable Banking](https://enablebanking.com) (PSD2 Account Information Services) to import balances and transactions — **read-only**; bank sync can never move money
- **Auto-Anchoring**: Each sync re-anchors the matching cash account to its real bank balance (a manual reconciliation still wins for its month), so forecasts stay grounded in reality with zero data entry
- **Credit-Card Tracking**: Cards report available + booked balances, from which Sampolio derives outstanding balance and credit limit, folds the liability into net worth, and injects the statement bill into the paying account's cash flow
- **"Paid by Card" Tagging**: Tag a recurring/one-off expense as paid by a card so it leaves direct cash and rolls into that card's statement and forecast bills (no double counting); set a per-card expected monthly spend buffer for long-term forecasts
- **Consent Renewal**: A reminder appears before bank consent expires, with a one-click reconnect
- **Privacy-First**: Connections, transactions, and sync logs are stored encrypted like all other data; IBANs are masked and never logged; the feature **hard-disables itself** when not configured

### Data Visualization
- **Sankey Flow Chart**: Visualize how income flows through the budget to expenses each month
- **Waterfall Chart**: Balance progression month-by-month showing how each month's net change builds on the previous
- **Treemap Chart**: Expense proportions by category and individual items
- **Net Worth Line Chart**: Track net worth trend over time
- **Wealth Composition Chart**: Stacked breakdown of assets over time (cash, investments, receivables, liabilities)
- **Mortgage Ownership Sankey**: Visualize how each monthly mortgage charge splits into interest, principal, fees, and ownership equity

### User Experience
- **Onboarding Wizard**: Guided 5-step setup for first-time users (account, income, expenses)
- **Command Palette**: Quick access to any action via keyboard (Cmd+K)
- **Keyboard Shortcuts**: Cmd+I (add income), Cmd+E (add expense), Cmd+M (monthly check-in / reconcile)
- **Dark/Light Theme**: System-wide toggle between custom forest-green light/dark themes with translucent liquid-glass chrome surfaces (generated from PrimeReact's Lara themes plus a hand-tuned override layer)
- **Simple/Advanced Display Mode**: Choose during onboarding (or later in Settings) how much of the app surfaces — Simple mode slims every nav surface to the core pages and uses plain-language labels, with everything else still reachable from Home's feature grid
- **Interactive Month Navigation**: Scrollable month strip for quick date navigation in cashflow view
- **Data Maintenance**: Prune accumulated reconciliation snapshots/sessions from Settings → Data & storage (preview then compact); projections stay byte-identical and mortgage data is never touched

### Administration
- **User Management**: Admin panel for creating, updating, and deactivating users
- **Role-Based Access**: Admin and user roles with first-user-becomes-admin logic
- **Self-Signup Control**: Admins can enable/disable public registration
- **Cache Management**: Force revalidation of all caches from settings

### Security & Privacy
- **File-Based Encrypted Storage**: AES-256-GCM encryption with HKDF-SHA256 key derivation — your data stays on your server
- **Password Security**: bcrypt hashing (12 rounds), strong password requirements (8+ chars, mixed case, numbers, special chars)
- **Brute Force Protection**: Account lockout after 10 failed attempts within 15 minutes
- **Rate Limiting**: Edge middleware caps unauthenticated auth requests (20/min) and general requests (300/min) per IP
- **Security Headers**: XSS protection, frame options, CSP, HSTS, restricted permissions policy
- **Self-Hosted**: Deploy by cloning and building on your own server — no external database needed

## Getting Started

### Prerequisites

- Node.js 26+
- pnpm (recommended) or npm

### Installation

1. Clone the repository:
```bash
git clone https://github.com/machadolucas/sampolio.git
cd sampolio
```

2. Install dependencies:
```bash
pnpm install
```

3. Set up environment variables:
```bash
cp .env.example .env.local
```

4. Generate secrets (update `.env.local` with these values):
```bash
# Generate AUTH_SECRET
openssl rand -base64 32

# Generate ENCRYPTION_KEY
openssl rand -hex 32
```

5. Run the development server:
```bash
pnpm dev
```

6. Open [http://localhost:4999](http://localhost:4999) and create your account

> **Note**: The first user to sign up automatically becomes an admin.

## Architecture

### Server Actions (No REST API)

The application uses Next.js Server Actions exclusively for all backend operations — there are no traditional REST API routes (except the NextAuth handler at `/api/auth/[...nextauth]`). All server actions are located in `src/lib/actions/` and follow a consistent pattern:

- `'use server'` directive at the top
- Input validation with Zod schemas
- Authentication check via `auth()`
- Return type: `ApiResponse<T>` (`{ success: boolean; data?: T; error?: string }`)
- Cache invalidation via `updateTag()` after mutations

### File-Based Encrypted Database

All data is stored as individually encrypted JSON files in `~/.sampolio/data/` (configurable):

```
~/.sampolio/data/
├── users-index.enc              # User ID/email lookup
├── app-settings.enc             # Global settings (self-signup, etc.)
├── shared/                      # Shared (non-user-scoped) entities
│   ├── mortgages/
│   │   ├── {mortgageId}.enc     # Shared mortgage (loans + members embedded)
│   │   └── {mortgageId}/        # rates/ costs/ extra-payments/ snapshots/
│   └── mortgage-members/
│       └── {userId}.enc         # Reverse index: userId → mortgageIds
└── users/
    └── {userId}/
        ├── user.enc             # Profile, password hash, role
        ├── preferences.enc      # Onboarding state, categories, tax defaults
        ├── accounts/
        │   └── {accountId}.enc  # Cash accounts
        ├── recurring-items/
        │   └── {itemId}.enc     # Recurring income/expenses
        ├── planned-items/
        │   └── {itemId}.enc     # One-off and repeating items
        ├── salary-configs/
        │   └── {configId}.enc   # Salary configurations
        ├── investments/
        │   └── {investmentId}.enc
        ├── debts/
        │   └── {debtId}.enc
        ├── receivables/
        │   └── {receivableId}.enc
        ├── taxed-income/
        │   └── {incomeId}.enc
        ├── budgets/
        │   └── {budgetId}.enc   # Trip/project budgets (lines, funding, expenses embedded)
        ├── goals/
        │   └── {goalId}.enc     # Financial goals
        ├── trips/
        │   └── {tripId}.enc     # Trips (per-diem reimbursements)
        ├── bank/                # Enable Banking sync (read-only, optional)
        │   ├── connections/     # Bank connections (linked accounts embedded)
        │   ├── accounts/        # {linkedAccountId}/transactions.enc — imported ledger
        │   └── sync-runs/       # Sync-run audit log
        └── reconciliation/
            ├── snapshots/       # Balance snapshots
            └── sessions/        # Reconciliation sessions
```

> **Note**: A mortgage is the one entity shared by multiple users, so it lives under `shared/` rather than under a single user. Access control is enforced in the action layer by checking the requester against the mortgage's member list.

**Encryption**: AES-256-GCM with per-file HKDF-SHA256 key derivation (fast). Each file has its own random salt and IV. Files written before the HKDF migration are still readable via a backward-compatible PBKDF2 fallback (100,000 iterations, LRU-cached); `scripts/reencrypt-data.mjs` migrates them to the fast format.

### Caching Strategy

- Next.js `cacheLife('indefinite')` for data queries (1-year stale/revalidate/expire)
- Granular cache tags per entity type: `user:{userId}:accounts`, `user:{userId}:debts`, etc.
- Cache invalidation via `updateTag()` after any mutation in server actions
- Admin can force-revalidate all caches from settings

### Projection Engine

**Cash Flow Projection** (`src/lib/projection.ts`):
1. Starts with each account's starting balance at its starting date
2. Iterates month-by-month through the planning horizon
3. For each month: applies recurring items (checking frequency/dates), one-off planned items, and occurrence overrides
4. Rolls up monthly data into yearly summaries

**Wealth Projection** (`src/lib/wealth-projection.ts`):
Aggregates across all entity types for each month:
- Cash accounts: balance from cashflow projection
- Investments: compound monthly growth + contributions - withdrawals
- Receivables: principal - repayments + interest accrual
- Debts: amortization schedule with interest (fixed or variable rates)
- Net worth: cash + investments + receivables - debts

## Documentation

Deep reference docs live in [`docs/`](docs/README.md) — architecture, the
projection/reconciliation engines, bank sync, the shared-mortgage engine,
feature references (Split/Budgets/Goals), operations/deploy, plus a verified
[known-gaps](docs/known-gaps.md) list and an evidence-backed
[improvements backlog](docs/improvements.md). Working conventions for
contributors and AI agents are in [`AGENTS.md`](AGENTS.md).

## Development

### VS Code Setup

This project includes VS Code configuration for debugging and running tasks.

#### Debug Configurations (`.vscode/launch.json`)

- **Next.js: debug server-side** - Debug server-side code with Chrome auto-open
- **Next.js: debug client-side** - Debug client-side code in Chrome
- **Next.js: debug full stack** - Combined server and client debugging
- **Next.js: run production build** - Build and run in production mode

To use: Open the Run and Debug panel (Cmd+Shift+D) and select a configuration.

#### Tasks (`.vscode/tasks.json`)

| Task | Description | Shortcut |
|------|-------------|----------|
| `dev` | Start development server | Default build task |
| `build` | Create production build | - |
| `start` | Start production server | - |
| `lint` | Run ESLint | - |
| `type-check` | Run TypeScript type checking | - |

To run: Use Command Palette (Cmd+Shift+P) > "Tasks: Run Task"

## Production Deployment

> For the maintainer's actual production topology — Cloudflare Tunnel + Cloudflare
> Access (Zero Trust) login gating, split-horizon DNS, Caddy, the `launchd`
> service, and where the bank-sync secrets live — see
> [`docs/operations.md`](docs/operations.md). The section below is the
> generic, portable self-hosting path.

The app is deployed by cloning this repository on the server and building it
**in place** with `./scripts/server-deploy.sh`. There is no separate packaging
step — `next start` serves the production build from the installed
`node_modules`, which avoids the standalone-bundle dependency-tracing issues that
broke the old zip-based packaging.

### Deploying on a server (git clone)

**Prerequisites on the server**: `git`, `pnpm`, and a Node.js version manager
(`fnm` or `nvm`) so the version pinned in [`.nvmrc`](.nvmrc) can be installed.

**1. Clone the repository:**
```bash
git clone https://github.com/machadolucas/sampolio.git ~/sampolio
cd ~/sampolio
```

**2. Install dependencies and build:**
```bash
./scripts/server-deploy.sh
```
This activates the Node version from `.nvmrc` (installing it via fnm/nvm if
needed), runs `pnpm install --frozen-lockfile`, and builds the app. It **refuses
to continue on the wrong Node major version**, so a mismatched server Node can't
silently produce a broken build.

**3a. Run manually (foreground):**
```bash
./scripts/run-sampolio.sh
```

**3b. Or install as an auto-starting service (recommended):**
```bash
./scripts/install-launchd.sh
```
The app starts automatically on login and restarts if it crashes. The resolved
Node binary path (matching `.nvmrc`) is baked into the launchd plist at install
time, so it doesn't depend on an interactive shell at boot.

#### Environment Variables on Deployment

**Recommended: Using .env File** (ensures secrets stay consistent)

The repo includes a `.env.example` template. Create your `.env` file at the repo root with fixed secrets:

```bash
# In the cloned repo (~/sampolio)
cp .env.example .env

# Generate your secrets
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env

# Edit .env to verify values
nano .env
```

Then run normally:
```bash
./scripts/run-sampolio.sh  # or ./scripts/install-launchd.sh
```

**Important**:
- Keep your `.env` file secure and backed up
- Never change `ENCRYPTION_KEY` — existing data will be unreadable
- Never commit `.env` to version control

**Alternative: Auto-Generated Secrets**

If you don't provide a `.env` file, secrets are auto-generated on first run:
- `AUTH_SECRET`: Stored in `~/.sampolio/data/.auth_secret`
- `ENCRYPTION_KEY`: Stored in `~/.sampolio/data/.encryption_key`

**Optional Environment Variables** (in .env or as exports):
```bash
SAMPOLIO_PORT=3999                    # Server port (default: 3999)
SAMPOLIO_HOST=0.0.0.0                # Server host (default: 0.0.0.0)
SAMPOLIO_DATA_DIR=~/.sampolio/data   # Data directory
```

**Migrating Data Between Servers**:

**Important**: Use the same `ENCRYPTION_KEY` to decrypt existing data.

**Method 1: Copy .env file and data** (simplest):
```bash
# On source server, backup everything
tar -czf sampolio-backup.tar.gz -C ~/sampolio .env -C ~/.sampolio data

# Transfer to new server (clone the repo there first, then:)
scp sampolio-backup.tar.gz new-server:~/

# On new server, extract into the clone
cd ~/sampolio
tar -xzf ~/sampolio-backup.tar.gz

# The .env file from source server is now in place
./scripts/server-deploy.sh && ./scripts/run-sampolio.sh
```

**Method 2: Using auto-generated secrets**:
```bash
# On source server, backup secrets and data
tar -czf sampolio-backup.tar.gz -C ~/.sampolio data

# Transfer to new server
scp sampolio-backup.tar.gz new-server:~/

# On new server, extract before first run
cd ~
mkdir -p .sampolio
tar -xzf sampolio-backup.tar.gz -C .sampolio

# Build, then run - will use existing .auth_secret and .encryption_key files
cd ~/sampolio
./scripts/server-deploy.sh && ./scripts/run-sampolio.sh
```

#### Upgrading to a New Version

On the server, pull the latest code and rebuild in place:

```bash
cd ~/sampolio

# (Optional) back up your data before a major upgrade
tar -czf ~/sampolio-data-backup-$(date +%Y%m%d).tar.gz -C ~/.sampolio data

# Pull + install + build in one step
./scripts/server-deploy.sh --pull

# Reload the service to pick up the new build
./scripts/install-launchd.sh   # re-running it reloads the launchd agent
```

If you run manually instead of via launchd, stop with `Ctrl+C` and start again
with `./scripts/run-sampolio.sh`.

Verify:
```bash
tail -f ~/.sampolio/logs/sampolio.log   # if using launchd
open http://localhost:3999
```

**Notes**:
- Your data in `~/.sampolio/data/` and your `.env` are untouched by upgrades.
- `--pull` runs `git pull --ff-only`; commit or stash local changes first.
- If `.nvmrc` changed, `server-deploy.sh` installs/activates the new Node version
  automatically (via fnm/nvm).
- To roll back: `git checkout <previous-tag-or-commit>` then
  `./scripts/server-deploy.sh`.

#### Uninstalling Auto-Start

```bash
./scripts/uninstall-launchd.sh
```

### Docker Deployment

The repo root includes a real `Dockerfile` (multi-stage: `pnpm install` +
`pnpm build`, then `next start` via `run.sh`) and `.dockerignore`. It builds
the app the same way [`scripts/server-deploy.sh`](scripts/server-deploy.sh)
does — no `output: 'standalone'`, see the comment in `next.config.ts`.

```bash
docker build -t sampolio .

# Option 1: Using .env file (recommended)
docker run -p 3999:3999 -v $(pwd)/data:/data/sampolio --env-file .env sampolio

# Option 2: Explicit environment variables
docker run -p 3999:3999 \
  -v $(pwd)/data:/data/sampolio \
  -e AUTH_SECRET=your-secret \
  -e ENCRYPTION_KEY=your-key \
  -e AUTH_URL=http://localhost:3999 \
  sampolio
```

`run.sh` also reads options from `/data/options.json` when present (Home
Assistant Supervisor's convention) so the same image doubles as the Home
Assistant add-on below — see that section for the option names.

### Home Assistant Add-on

This repository is also directly installable as a Home Assistant Supervisor
add-on: `config.yaml` and `repository.yaml` at the repo root describe it, and
it builds from the same `Dockerfile` above. In Home Assistant: **Settings →
Add-ons → Add-on Store → ⋮ → Repositories**, add this repo's URL, then
install **Sampolio** from the store. It's Ingress-only (no direct port) —
reachable only through an authenticated Home Assistant session. Full option
reference, the Ingress/framing tradeoff, and an optional embedded-Tailscale
path for Enable Banking's public callback requirement are in
[`DOCS.md`](DOCS.md).

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `AUTH_SECRET` | NextAuth.js secret key | Yes* | Auto-generated |
| `ENCRYPTION_KEY` | 64-character hex key for file encryption | Yes* | Auto-generated |
| `AUTH_TRUST_HOST` | Set to `true` behind reverse proxy | No | - |
| `AUTH_URL` | Public URL for auth (behind reverse proxy) | No | - |
| `DATA_DIR` / `SAMPOLIO_DATA_DIR` | Custom data directory path | No | `~/.sampolio/data` |
| `PORT` / `SAMPOLIO_PORT` | Server port | No | `3999` |
| `HOSTNAME` / `SAMPOLIO_HOST` | Server hostname | No | `0.0.0.0` |
| `ENABLE_BANKING_APP_ID` | Enable Banking application ID (bank sync) | No | - |
| `ENABLE_BANKING_REDIRECT_URL` | Consent callback URL (`<public-url>/api/bank/callback`) | No | - |
| `ENABLE_BANKING_PRIVATE_KEY_FILE` | Path to the RS256 private key PEM (0600, outside the repo) | No | - |

*Auto-generated if not provided, but using a `.env` file with fixed values is recommended for production.

> **Bank sync** is fully optional. Leave the three `ENABLE_BANKING_*` variables unset and the feature hard-disables itself (no network calls, a "not configured" notice in Settings). When set, the consent callback URL must be publicly reachable.

## Tech Stack

- **Framework**: Next.js 16 (App Router, Server Actions)
- **Language**: TypeScript (strict mode)
- **Authentication**: NextAuth.js v5 (JWT sessions, credentials provider)
- **UI Components**: PrimeReact with PrimeIcons
- **Styling**: Tailwind CSS v4
- **Icons**: PrimeIcons, Lucide React, React Icons
- **Forms**: React Hook Form + Zod validation
- **Charts**: ECharts (via echarts-for-react), Chart.js
- **Date Handling**: date-fns
- **Encryption**: Node.js crypto (AES-256-GCM, HKDF-SHA256 with a legacy PBKDF2 read fallback)
- **Password Hashing**: bcryptjs
- **Bank Sync**: Enable Banking (PSD2 AIS) via `jose` (RS256 JWT) — optional, read-only
- **IDs**: uuid v14

## Scripts Reference

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start development server on port 4999 |
| `pnpm build` | Create production build |
| `pnpm start` | Start production server |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run the test suite (Vitest) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:coverage` | Run tests with coverage report |
| `./scripts/server-deploy.sh` | Install deps + build in place on the server (`--pull` to git pull first, `--run` to start after) |
| `./scripts/run-sampolio.sh` | Run the production server in the foreground |
| `./scripts/install-launchd.sh` | Install/reload macOS auto-start (launchd) |
| `./scripts/uninstall-launchd.sh` | Remove macOS auto-start |

## File Locations

| Path | Description |
|------|-------------|
| `~/.sampolio/data/` | User data and settings (encrypted) |
| `~/.sampolio/logs/` | Application logs (when using launchd) |
| `~/Library/LaunchAgents/com.sampolio.app.plist` | launchd configuration |

## License

MIT
