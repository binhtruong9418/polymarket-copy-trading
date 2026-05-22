# Polymarket Copy-Trading Bot

Ultra-low-latency copy-trading bot for Polymarket. Automatically mirrors trades from target wallets with configurable sizing, risk guards, and real-time alerts via Telegram/Slack.

**Key Features:**
- Sub-second latency via WebSocket trade streaming
- Proportional or exact-size copy strategies
- Multi-tier risk controls (balance, exposure, drawdown guards)
- SQLite state persistence with crash recovery
- Dry-run mode for testing (no live orders)
- Telegram/Slack notifications
- 7-module modular architecture

## Quick Start

### Prerequisites
- Node.js 20.10+
- Polygon wallet private key (for live trading)
- Polymarket API credentials (for live trading)
- Telegram/Slack webhooks (optional)

### Install & Configure

```bash
# Clone and install
git clone <repo>
cd polymarket-copy-trading
npm install

# Copy env template and configure
cp .env.example .env

# Edit .env:
# Set DRY_RUN=true for testing, false for live
# Add TARGET_WALLETS (comma-separated addresses to copy)
# Set copy strategy (exact or proportional) and limits
# Add notification webhooks if desired
```

### Run Commands

```bash
# Start bot (mode controlled by DRY_RUN env var)
npm start

# Run tests
npm test

# Check types
npm run typecheck

# Lint code
npm run lint
```

## Modes

### Dry-Run (DRY_RUN=true)
- Monitors target wallets in real-time
- Sends Telegram alerts only (no orders)
- Validates signal filters and risk checks
- **Use for:** Testing strategies, monitoring, validation

### Live Trading (DRY_RUN=false)
- Places actual orders on Polymarket
- Requires CLOB API credentials
- Persists state to SQLite (crash-safe)
- **Use for:** Production copy-trading

## Environment Variables

| Variable | Type | Required | Default | Notes |
|----------|------|----------|---------|-------|
| `DRY_RUN` | bool | no | true | false = live trading |
| `TARGET_WALLETS` | string | yes | — | Comma-separated 0x addresses |
| `COPY_STRATEGY` | enum | no | proportional | exact &#124; proportional |
| `COPY_RATIO` | float | no | 0.1 | Multiplier for proportional (0.01–1) |
| `MAX_NOTIONAL_PER_TRADE` | float | no | 50 | USDC cap per copied trade |
| `MAX_MARKET_EXPOSURE` | float | no | 500 | Max USDC per market |
| `MAX_SESSION_NOTIONAL` | float | no | 2000 | Max USDC total per session |
| `MAX_DRAWDOWN_PCT` | float | no | 15 | Halt if drawdown exceeds % |
| `TELEGRAM_BOT_TOKEN` | string | no | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | string | no | — | Telegram chat/group ID |
| `SLACK_WEBHOOK_URL` | string | no | — | Slack incoming webhook |
| `POLYMARKET_API_KEY` | string | live only | — | CLOB API credential |
| `POLYMARKET_SECRET` | string | live only | — | CLOB API credential |
| `POLYMARKET_PASSPHRASE` | string | live only | — | CLOB API credential |
| `PRIVATE_KEY` | string | live only | — | Polygon wallet private key (0x-prefixed) |
| `FUNDER_ADDRESS` | string | no | — | Proxy wallet address (optional) |
| `LOG_LEVEL` | enum | no | info | trace &#124; debug &#124; info &#124; warn &#124; error |

## Architecture Overview

**7 Core Modules:**

```
config/           → Environment & trading config (Zod validation)
signal/           → Trade detection (WS + REST fallback)
execution/        → Order building & submission (CLOB API)
risk/             → 6-tier risk guard system
state/            → SQLite persistence & recovery
monitoring/       → Orchestration, health checks, alerts
runners/          → Entry points (dry-run vs live)
```

**Data Flow:**
```
Polymarket WS → Trade Filter → Dedup Cache → Signal Emitter
→ Bot Orchestrator → Risk Engine (6 guards)
→ Order Executor → CLOB API → SQLite Log → Alerts
```

## Key Concepts

### Copy Strategies
- **Exact:** Copy the exact size from target trade
- **Proportional:** Scale by COPY_RATIO (e.g., 0.1 = 10% of target size)

### Risk Guards (Sequential)
1. **SELL Guard** – Reject BUY if no opposing SELL exists
2. **Staleness Guard** – Reject if signal is >10s old
3. **Min Size Guard** – Reject if adjusted size <$1
4. **Balance Guard** – Cap to available balance × 0.95
5. **Exposure Guard** – Reject if market allocation exceeded
6. **Drawdown Guard** – Halt all trading if >MAX_DRAWDOWN_PCT

### State Persistence
- SQLite WAL mode (synchronous writes, <1ms latency)
- Events table: ORDER_SUBMITTED, ORDER_FILLED, ORDER_FAILED, POSITION_CLOSED
- Automatic state recovery on restart
- Live API reconciliation

## Deployment

See `docs/deployment-guide.md` for:
- Server requirements
- PM2 setup
- Environment configuration
- Monitoring setup

## Documentation

- `docs/project-overview-pdr.md` – Product requirements and constraints
- `docs/code-standards.md` – Code conventions and structure
- `docs/codebase-summary.md` – Module map and file listing
- `docs/system-architecture.md` – Data flow and components
- `docs/project-roadmap.md` – Status and future work
- `docs/deployment-guide.md` – Deployment and operations

## Development

### Run tests
```bash
npm test
npm test:watch      # Watch mode
npm test:coverage   # Coverage report
```

### Check types & lint
```bash
npm run typecheck
npm run lint
```

### Build
```bash
npm run build       # Compile TypeScript → dist/
```

## Support

For issues or questions, see `docs/` directory or contact the project maintainer.
