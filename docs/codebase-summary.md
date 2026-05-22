# Codebase Summary

## Overview

**Total LOC:** ~1,549 (src/) + 300+ (tests/)  
**Architecture:** 7 modules + 2 utility modules  
**Entry Point:** src/index.ts  
**Runtime:** Node.js 20.10+, ESM, tsx transpiler  
**Test Framework:** Vitest

## Directory Structure

```
src/
├── index.ts                          # Main entry point (mode branching)
├── config/                           # Environment & trading config
│   ├── env-config.ts                 # Zod env schema, validation
│   └── trading-config.ts             # Copy rule builder
├── signal/                           # Trade detection
│   ├── signal-emitter.ts             # EventEmitter wrapper
│   ├── trade-filter.ts               # WS message parser & filter
│   ├── market-enricher.ts            # Gamma API fallback
│   └── ws-client.ts                  # RealTimeDataClient lifecycle
├── execution/                        # Order building & submission
│   ├── order-builder.ts              # Copy rule → CLOB order
│   ├── order-executor.ts             # Async order submission
│   ├── dedup-cache.ts                # LRU cache (500, 5min TTL)
│   └── clob-client-singleton.ts      # Ethers.js CLOB wrapper
├── risk/                             # 6-tier guard system
│   ├── risk-engine.ts                # Sequential guard pipeline
│   ├── balance-guard.ts              # Balance check & refresh
│   ├── exposure-guard.ts             # Market allocation check
│   └── drawdown-guard.ts             # Drawdown halt & persistence
├── state/                            # SQLite persistence
│   ├── position-store.ts             # In-memory position ledger
│   ├── session-tracker.ts            # Session PnL tracking
│   ├── transaction-log.ts            # SQLite events table
│   └── state-recovery.ts             # Replay & reconciliation
├── monitoring/                       # Orchestration & health
│   ├── bot-orchestrator.ts           # Main lifecycle manager
│   ├── alert-notifier.ts             # Telegram/Slack alerts
│   ├── health-checker.ts             # WS staleness + CLOB ping
│   └── metrics-tracker.ts            # Latency & PnL metrics
├── runners/                          # Entry points
│   └── dry-run-runner.ts             # DRY_RUN=true handler
├── types/                            # TypeScript interfaces
│   └── index.ts                      # Shared type definitions
└── utils/                            # Helpers
    └── logger.ts                     # Pino logger setup

tests/
├── unit/
│   ├── signal/
│   ├── execution/
│   ├── risk/
│   ├── state/
│   └── ...
└── integration/
    └── ...
```

## Module Breakdown

### 1. config/ (~84 LOC)

**Purpose:** Environment validation and copy rule derivation.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| env-config.ts | 65 | `env`, `EnvConfig`, `assertLiveTradingCreds()` | Zod schema + runtime validation |
| trading-config.ts | 19 | `buildCopyRules()`, `getRuleForWallet()` | Map TARGET_WALLETS → CopyRule[] |

**Key Concepts:**
- Zod schema enforces strict types at startup
- `assertLiveTradingCreds()` called only for DRY_RUN=false
- Copy rules built from env vars; never reloaded at runtime

---

### 2. signal/ (~311 LOC)

**Purpose:** Detect target wallet trades via public WebSocket + REST fallback.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| signal-emitter.ts | 45 | `SignalEmitter` class | EventEmitter → TradeSignal events |
| trade-filter.ts | 78 | `parseTradeMessage()` | WS message parser, wallet filter |
| market-enricher.ts | 85 | `enrichSignal()` | Gamma API fallback for metadata |
| ws-client.ts | 103 | `connectWebSocket()`, `reconnect()` | RealTimeDataClient lifecycle |

**Data Flow:**
```
RealTimeDataClient WS event
  → parseTradeMessage (filter by proxyWallet)
  → enrichSignal (add market title/outcome)
  → SignalEmitter.emit('trade') → BotOrchestrator
```

**Key Features:**
- Filters by source wallet address (proxyWallet in trade event)
- Gamma API enrichment (in-memory cache) for missing metadata
- REST polling fallback (2s interval) if WS disconnects
- Returns enriched `TradeSignal` objects

---

### 3. execution/ (~246 LOC)

**Purpose:** Build and submit copy orders to CLOB API.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| order-builder.ts | 67 | `buildCopyOrder()` | Apply strategy + sizing rules |
| order-executor.ts | 62 | `OrderExecutor` class | Async order submission + retry |
| dedup-cache.ts | 48 | `DedupCache` class | LRU cache (500, 5min TTL) |
| clob-client-singleton.ts | 69 | `initClobClient()`, `getClobClient()` | Ethers.js + CLOB client |

**Order Building:**
```
TradeSignal + CopyRule
  → Apply COPY_STRATEGY (exact or proportional)
  → Cap at maxPerTrade
  → Validate ≥$1 minimum
  → Return CLOB OrderRequest
```

**Submission:**
- `createAndPostOrder()` via ethers.js CLOB contract
- Async/await with error handling
- Circuit breaker: 5 failures → 60s pause
- All orders logged before submission

**Deduplication:**
- LRU cache (500 entries, 5min TTL)
- Key: transactionHash from TradeSignal.id
- Prevents duplicate CLOB submissions

---

### 4. risk/ (~198 LOC)

**Purpose:** 6-tier sequential guard system before order approval.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| risk-engine.ts | 68 | `RiskEngine` class | Sequential guard pipeline |
| balance-guard.ts | 54 | `refreshBalance()`, `getCachedBalance()` | Balance check + HTTP fetch |
| exposure-guard.ts | 38 | `checkExposure()` | Market allocation cap |
| drawdown-guard.ts | 38 | `checkDrawdown()` | Drawdown halt + SQLite persistence |

**Guard Pipeline (Seq):**
1. SELL Guard: Reject BUY if no SELL position exists
2. Staleness: Reject if signal age >10s
3. Min Size: Reject if adjusted <$1
4. Balance: Cap to min(maxPerTrade, balance × 0.95)
5. Exposure: Reject if market allocation exceeded
6. Drawdown: Halt all trades if session drawdown ≥MAX_DRAWDOWN_PCT

**Each guard returns `RiskDecision`:**
```typescript
{
  approved: boolean,
  adjustedSize?: number,      // After balance cap
  reason?: string             // Why rejected
}
```

**Drawdown Persistence:**
- Stored in SQLite, checked on startup
- 24h halt applies across restarts
- Stateless for all other guards

---

### 5. state/ (~246 LOC)

**Purpose:** SQLite persistence and state recovery.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| position-store.ts | 62 | `PositionStore` class | In-memory open position ledger |
| session-tracker.ts | 48 | `SessionTracker` class | Session PnL, start balance tracking |
| transaction-log.ts | 68 | `TransactionLog` class | SQLite events table |
| state-recovery.ts | 68 | `recoverState()`, `reconcileWithLive()` | Replay + CLOB API sync |

**SQLite Schema:**
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  type TEXT,                          -- ORDER_SUBMITTED, ORDER_FILLED, etc.
  payload TEXT,                       -- JSON: {orderId, size, price, ...}
  ts INTEGER,                         -- Unix ms
  created_at DATETIME DEFAULT now()
);
```

**Recovery Flow:**
1. Load all events from SQLite
2. Replay ORDER_SUBMITTED → POSITION_CLOSED to rebuild in-memory state
3. Query live CLOB API for open orders
4. Reconcile: match by conditionId/tokenId/side
5. Alert if orphaned orders detected

---

### 6. monitoring/ (~274 LOC)

**Purpose:** Orchestration, health checks, and multi-channel alerts.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| bot-orchestrator.ts | 88 | `BotOrchestrator` class | Main lifecycle (init → run → shutdown) |
| alert-notifier.ts | 76 | `sendAlert()`, rate limiter | Telegram/Slack with 5min dedup |
| health-checker.ts | 54 | `HealthChecker` class | WS staleness + CLOB API ping |
| metrics-tracker.ts | 56 | `MetricsTracker` class | P50/P99 latency, PnL tracking |

**BotOrchestrator Lifecycle:**
1. Init CLOB client → fetch balance
2. Recover state from SQLite
3. Wire signal emitter, executor, risk engine
4. Listen to executor events → log + metrics + alerts
5. Graceful shutdown on SIGTERM

**Health Checks (every 60s):**
- WS staleness >2min → escalated alert
- CLOB API ping timeout → fallback to REST polling
- Balance refresh every 5min

**Metrics:**
- P50/P99 order latency (detection → submission)
- Fill rate, session PnL
- Logged every 5min

**Alerts:**
- Telegram: primary (emoji prefixes for severity)
- Slack: secondary (color-coded blocks)
- Rate limited: 1x per 5min per (severity, tag)

---

### 7. runners/ (~84 LOC)

**Purpose:** Entry points for different modes.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| dry-run-runner.ts | 84 | `startDryRunRunner()` | DRY_RUN=true handler |

**Dry-Run Mode:**
- Connects to RealTimeData WS
- Parses trades, applies signal filter
- Validates risk guards (no order submission)
- Sends Telegram alerts only
- Useful for testing strategies without live orders

---

### 8. types/ (~65 LOC)

**Purpose:** Shared TypeScript interfaces.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| index.ts | 65 | All interfaces | TradeSignal, CopyRule, OpenPosition, etc. |

**Key Interfaces:**
- `TradeSignal` – detected trade metadata
- `CopyRule` – strategy + sizing rules per wallet
- `OpenPosition` – current market position
- `PendingOrder` – submitted but not filled order
- `LogEvent` – transaction log entry
- `RiskDecision` – guard approval + reason

---

### 9. utils/ (~12 LOC)

**Purpose:** Shared utilities.

#### Files

| File | LOC | Exports | Responsibility |
|------|-----|---------|-----------------|
| logger.ts | 12 | `logger` | Pino JSON logger setup |

---

## Entry Point

**File:** `src/index.ts` (19 LOC)

```typescript
// Branching on DRY_RUN env var:
if (env.DRY_RUN) {
  // startDryRunRunner() → WS monitor + Telegram
} else {
  // assertLiveTradingCreds() → BotOrchestrator.start()
}
```

**Startup Order:**
1. Load env (Zod validation, throw if invalid)
2. Branch on DRY_RUN
3. Init CLOB client (live only)
4. Recover state from SQLite
5. Connect to RealTimeData WS
6. Begin listening for trades

---

## Code Metrics

| Metric | Value |
|--------|-------|
| Total LOC (src/) | 1,549 |
| Total LOC (tests/) | 300+ |
| Largest module | signal/, state/ (311, 246) |
| Largest file | ws-client.ts (103) |
| Average file size | 65 LOC |
| Total functions | ~45 |
| Total classes | ~12 |
| TypeScript strict | Yes |
| Test coverage target | >70% |

---

## Dependencies

### Production
| Package | Version | Purpose |
|---------|---------|---------|
| @polymarket/clob-client | ^5.8.1 | CLOB API via ethers.js |
| @polymarket/real-time-data-client | ^1.4.0 | WebSocket trade stream |
| ethers | ^5.8.0 | Blockchain interaction |
| better-sqlite3 | ^11.10 | SQLite persistence |
| zod | ^3.25 | Env validation |
| pino | ^9.7 | JSON logging |
| dotenv | ^16.5 | .env loading |

### Development
| Package | Version | Purpose |
|---------|---------|---------|
| typescript | ^5.8 | Type checking |
| tsx | ^4.19 | ESM runtime |
| vitest | ^3.2 | Unit tests |
| @biomejs/biome | ^1.9 | Linting |

---

## Build & Runtime

### Build Process
```bash
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
npm run lint       # biome check src/
```

### Runtime
```bash
npm start          # tsx src/index.ts (no compilation needed)
```

### Output
- Logs → stdout (JSON format via pino)
- SQLite → `./polymarket.db` (WAL mode)
- Alerts → Telegram/Slack webhooks (async)

---

## File Ownership & Module Boundaries

| Module | Primary Files | Responsibilities | Dependencies |
|--------|---------------|------------------|--------------|
| config | env-config.ts, trading-config.ts | Env parsing, copy rule building | None (standalone) |
| signal | signal-emitter.ts, trade-filter.ts, market-enricher.ts, ws-client.ts | Trade detection via WS/REST | config (for env) |
| execution | order-builder.ts, order-executor.ts, dedup-cache.ts, clob-client-singleton.ts | Order submission logic | config, types |
| risk | risk-engine.ts, balance-guard.ts, exposure-guard.ts, drawdown-guard.ts | Guard pipeline | state, types |
| state | position-store.ts, session-tracker.ts, transaction-log.ts, state-recovery.ts | Persistence & recovery | types |
| monitoring | bot-orchestrator.ts, alert-notifier.ts, health-checker.ts, metrics-tracker.ts | Orchestration & observability | all other modules |
| runners | dry-run-runner.ts | Entry point branching | signal, config, types |

---

## Testing Strategy

- **Unit tests:** Per-module (signal, execution, risk, state, config)
- **Integration tests:** Full flow (signal → risk → execution → state)
- **Coverage target:** >70% of logic
- **Mocks:** CLOB client, WebSocket, SQLite (in test env)

---

## Next Steps for New Developers

1. Read `README.md` (quick start)
2. Read `system-architecture.md` (data flow + diagrams)
3. Read module breakdown above
4. Explore `src/types/index.ts` (interfaces)
5. Trace signal → order flow in `bot-orchestrator.ts`
6. Run `npm test` to validate setup
