# System Architecture

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ Polymarket RealTimeData (Public WebSocket)                          │
│ Topic: activity/trades - all market trades (no auth needed)         │
└────────────────────────────┬────────────────────────────────────────┘
                             │ trade event
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Signal Module (signal/)                                              │
│ ├─ ws-client: WS lifecycle + reconnect on disconnect               │
│ ├─ trade-filter: Filter by proxyWallet (source wallet)             │
│ ├─ market-enricher: Gamma API fallback for metadata                │
│ └─ signal-emitter: EventEmitter → TradeSignal events              │
└────────────────────────────┬────────────────────────────────────────┘
                             │ TradeSignal
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Dedup Cache (execution/)                                             │
│ LRU 500 entries, 5min TTL → prevent duplicate orders               │
└────────────────────────────┬────────────────────────────────────────┘
                             │ if not in cache
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Bot Orchestrator (monitoring/)                                       │
│ Main lifecycle: receives TradeSignal → triggers risk + execution    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Risk Engine (risk/) - 6 Sequential Guards                            │
│ 1. SELL Guard: Reject BUY if no opposing SELL position             │
│ 2. Staleness: Reject if signal age > 10s                           │
│ 3. Min Size: Reject if adjusted < $1                               │
│ 4. Balance: Cap to min(maxPerTrade, balance × 0.95)                │
│ 5. Exposure: Reject if market allocation exceeded                  │
│ 6. Drawdown: Halt if session drawdown ≥ MAX_DRAWDOWN_PCT           │
└────────────────────────────┬────────────────────────────────────────┘
                             │ RiskDecision { approved, adjustedSize }
                             ▼
         ┌───────────────────┴───────────────────┐
         │                                       │
    Rejected                               Approved
    (alert)                                   │
         │                                   ▼
         │                    ┌─────────────────────────────────────┐
         │                    │ Order Builder (execution/)           │
         │                    │ - Apply strategy (exact|proportional)│
         │                    │ - Cap to maxPerTrade                │
         │                    │ - Return OrderRequest               │
         │                    └──────────────┬──────────────────────┘
         │                                   │
         │                                   ▼
         │                    ┌─────────────────────────────────────┐
         │                    │ Order Executor (execution/)          │
         │                    │ - createAndPostOrder() via CLOB API │
         │                    │ - Circuit breaker (5 failures)      │
         │                    │ - Async/await with retry logic      │
         │                    └──────────────┬──────────────────────┘
         │                                   │
         │                                   ▼
         │                    ┌─────────────────────────────────────┐
         │                    │ CLOB API (createAndPostOrder)        │
         │                    │ - GTC limit order on Polymarket     │
         │                    │ - Polygon blockchain                │
         │                    └──────────────┬──────────────────────┘
         │                                   │
         │                    ┌──────────────▼──────────────┐
         │                    │ Response                     │
         │     ┌──────────────┴─────────────┬──────────────┐
         │     │                            │              │
      SUCCESS                          SUBMITTED        FAILED
         │     │                            │              │
         │     └───────┬──────────────┬─────┘              │
         │             │              │                    │
         │             ▼              ▼                    ▼
         │    ┌───────────────────────────────┐   ┌──────────────┐
         │    │ Transaction Log (state/)       │   │ Alert (fail) │
         │    │ SQLite: events table           │   └──────────────┘
         │    │ - ORDER_SUBMITTED              │
         │    │ - ORDER_FILLED (on watcher)    │
         │    │ - ORDER_FAILED                 │
         │    │ - POSITION_CLOSED              │
         │    └───────────┬─────────────────────┘
         │                │
         │                ▼
         │    ┌───────────────────────────────┐
         │    │ State Recovery (state/)        │
         │    │ - Replay events on startup     │
         │    │ - Reconcile with live CLOB API│
         │    └───────────────────────────────┘
         │
         └──────────────────┬─────────────────┐
                            │                 │
                            ▼                 ▼
                    ┌────────────────┐  ┌──────────────┐
                    │ Metrics Track  │  │ Alert (via   │
                    │ - P50/P99 lat  │  │  Telegram/   │
                    │ - Fill rate    │  │  Slack)      │
                    │ - Session PnL  │  │ rate-limited │
                    └────────────────┘  └──────────────┘
```

---

## Component Architecture

### 1. Signal Detection (signal/)

**Responsibility:** Stream trades from target wallets via public WebSocket.

```
RealTimeDataClient (Polymarket WS)
  ↓
WS Client (lifecycle, reconnect)
  ↓
Trade Filter (proxyWallet address match)
  ↓
Market Enricher (title, outcome from Gamma API)
  ↓
Signal Emitter (EventEmitter → 'trade' events)
  ↓
Bot Orchestrator (consumes signals)
```

**Key Features:**
- Public WS (no auth)
- Automatic reconnect on disconnect
- REST fallback (2s polling) if WS down >30s
- In-memory cache for Gamma API metadata (1hr TTL)

**Output:** `TradeSignal` interface
```typescript
{
  id: string;              // transactionHash (dedup key)
  sourceWallet: string;    // proxyWallet
  conditionId: string;     // Market ID
  tokenId: string;         // Outcome token
  side: "BUY" | "SELL";
  price: number;           // 0–1 probability
  size: number;            // USDC
  timestamp: number;       // Event time
  detectedAt: number;      // Bot received time
  title?: string;          // Market title
  outcome?: string;        // Outcome label
  slug?: string;           // Market slug
}
```

---

### 2. Execution (execution/)

**Responsibility:** Build and submit copy orders to CLOB API.

```
TradeSignal + CopyRule
  ↓
Order Builder (strategy: exact | proportional, size cap)
  ↓
Dedup Cache (LRU 500, 5min TTL — check transactionHash)
  ↓ if not cached
  ↓
Order Executor (async CLOB submission)
  ↓
Circuit Breaker (5 failures → 60s pause)
  ↓
CLOB API (createAndPostOrder)
```

**Copy Strategies:**
- **Exact:** Copy exact USDC size from signal
- **Proportional:** Scale by COPY_RATIO (0.01–1.0)

**Size Validation:**
```
adjusted_size = strategy === "exact" 
  ? signal.size 
  : signal.size * COPY_RATIO

final_size = min(adjusted_size, MAX_NOTIONAL_PER_TRADE)

if (final_size < 1.0) reject
```

**Circuit Breaker:**
```
consecutive_failures = 0
on error:
  consecutive_failures++
  if (consecutive_failures >= 5):
    pause_order_submissions = true
    set_timer(60s)
    on timer expire:
      consecutive_failures = 0
      pause_order_submissions = false
```

---

### 3. Risk Management (risk/)

**Responsibility:** 6-tier sequential guard system.

```
TradeSignal
  ↓
Guard 1: SELL Check
  Reject BUY if no opposing SELL position in market
  ↓ (pass)
Guard 2: Staleness
  Reject if signal.timestamp < now - 10s
  ↓ (pass)
Guard 3: Min Size
  Reject if adjusted_size < $1
  ↓ (pass)
Guard 4: Balance Guard
  Cap to min(maxPerTrade, available_balance × 0.95)
  ↓ (pass)
Guard 5: Exposure Guard
  Reject if market allocation would exceed MAX_MARKET_EXPOSURE
  ↓ (pass)
Guard 6: Drawdown Guard
  Halt all trades if session drawdown ≥ MAX_DRAWDOWN_PCT
  (persists 24h via SQLite)
  ↓ (pass)
Approved ✓
```

**Guard Result:**
```typescript
{
  approved: boolean;
  adjustedSize?: number;  // After balance cap
  reason?: string;        // Why rejected
}
```

**Drawdown Persistence:**
- Stored in SQLite `drawdown_halt` table
- Checked on startup for lingering halts
- 24h window (now - ts < 24h)

---

### 4. State Management (state/)

**Responsibility:** SQLite persistence, state recovery on restart.

```
Position Store (in-memory ledger)
  ├─ conditionId:tokenId:side → OpenPosition
  └─ Rebuilt on startup from events

Session Tracker (in-memory PnL)
  ├─ startBalance
  ├─ currentBalance
  ├─ session drawdown %
  └─ Rebuilt on startup

Transaction Log (SQLite WAL mode)
  ├─ events table
  │   ├─ id (auto increment)
  │   ├─ type (enum: ORDER_SUBMITTED, ORDER_FILLED, ORDER_FAILED, POSITION_CLOSED)
  │   ├─ payload (JSON)
  │   ├─ ts (Unix ms)
  │   └─ created_at (DATETIME)
  │
  └─ drawdown_halt table
      ├─ halted_at (Unix ms)
      └─ reason (string)

State Recovery (on startup)
  1. Load all events from SQLite
  2. Replay: reconstruct positions, session state
  3. Query live CLOB API for open orders
  4. Reconcile: match by conditionId/tokenId/side
  5. Alert if orphaned orders found
```

**Event Schema:**
```json
{
  "type": "ORDER_SUBMITTED",
  "payload": {
    "orderId": "...",
    "conditionId": "...",
    "tokenId": "...",
    "side": "BUY",
    "size": 50,
    "price": 0.65,
    "sourceTradeId": "0x..."
  },
  "ts": 1716408000000
}
```

---

### 5. Orchestration (monitoring/)

**Responsibility:** Main lifecycle, health checks, metrics, alerting.

```
BotOrchestrator.start()
  ├─ Init CLOB client
  ├─ Refresh balance (cache 5min)
  ├─ Recover state from SQLite
  ├─ Reconcile with live CLOB API
  ├─ Start signal emitter (WS + REST fallback)
  ├─ Wire event listeners
  ├─ Start health checker (every 60s)
  ├─ Start metrics reporter (every 5min)
  └─ Listen for SIGTERM → graceful shutdown

On TradeSignal:
  ├─ Check dedup cache
  ├─ Evaluate risk engine (6 guards)
  ├─ If rejected: alert + log
  ├─ If approved: submit order
  ├─ Log event to SQLite
  ├─ Update metrics
  └─ Send alert

Health Checker (every 60s):
  ├─ Check WS staleness (if >2min: escalate alert)
  ├─ Ping CLOB API
  └─ Fallback to REST polling if CLOB down

Graceful Shutdown:
  ├─ Close WS connection
  ├─ Flush pending events to SQLite
  ├─ Log final metrics
  └─ Exit
```

---

## Data Consistency & Recovery

### Crash Scenarios

**Scenario 1: Bot crashes during order submission**
```
Event: ORDER_SUBMITTED logged to SQLite ✓
API response: pending

Recovery:
  1. Bot restarts
  2. Queries CLOB API for open orders
  3. Finds order by conditionId/tokenId/side
  4. Reconciles: already in system ✓
  5. Continues monitoring for fill
```

**Scenario 2: Bot crashes after order fill (not logged)**
```
Event: ORDER_SUBMITTED logged to SQLite ✓
Event: ORDER_FILLED not yet logged (crash)

Recovery:
  1. Bot restarts
  2. Queries CLOB API for open orders
  3. Order not found (already closed)
  4. Queries recent closed orders via CLOB API
  5. Finds filled order
  6. Logs ORDER_FILLED retroactively
  7. Updates position store
```

**Scenario 3: Network split (orders hang in flight)**
```
Event: ORDER_SUBMITTED logged to SQLite ✓
Network disconnect: no API response

Recovery:
  1. Bot reconnects to CLOB API
  2. Queries open orders
  3. If found: waits for fill (monitoring loop)
  4. If not found after timeout (2min): logs ORDER_FAILED
  5. Position store updated accordingly
```

### Deduplication Strategy

**Goal:** Prevent duplicate orders from same signal.

**Mechanism:** LRU cache (500 entries, 5min TTL)
- Key: `TradeSignal.id` (transactionHash)
- Value: timestamp of order submission
- Check: before order builder

**Fallback:** SQLite transaction log
- If cache lost on restart
- Check recent ORDER_SUBMITTED events for same transactionHash
- Prevents re-submission

---

## Sequence Diagrams

### Happy Path: Trade Detection → Order Filled

```
Polymarket        Signal          Dedup       Risk          Executor      CLOB       State
    │              Module         Cache      Engine           │            │          │
    │                │              │          │              │            │          │
    ├─ trade ──────>│              │          │              │            │          │
    │              │ parse ──────>│          │              │            │          │
    │              │              │ hit? ──>│              │            │          │
    │              │<── no ────────│          │              │            │          │
    │              │              │          │<─ eval ─────│            │          │
    │              │              │          │ 6 guards    │            │          │
    │              │              │          │─ approved ─>│            │          │
    │              │              │          │              │            │          │
    │              │              │          │              ├─ build ───>│          │
    │              │              │          │              │            │          │
    │              │              │          │              │<─ request ─┤          │
    │              │              │          │              │            │          │
    │              │              │          │              ├─ POST ────>│          │
    │              │              │          │              │            ├─submit ─>│
    │              │              │          │              │            │<─ id ────┤
    │              │              │          │              │<─ id ──────┤          │
    │              │              │          │              │            │          │
    │              │              │          │              ├────────────────────────┤
    │              │              │          │              │ log: ORDER_SUBMITTED   │
    │              │              │          │              │            │          │
    │              │              │          │              ├─────────────────────>│
    │              │              │          │              │            │          │
    │ (poll) ──────────────────────────────────────────────────────────────────────>│
    │              │              │          │              │            │          │
    │<─ order_filled ────────────────────────────────────────────────────────────────┤
    │              │              │          │              │            │          │
    │              │              │          │              │ (via watcher loop)     │
    │              │              │          │              ├──────────────────────>│
    │              │              │          │              │ log: ORDER_FILLED     │
    │              │              │          │              │            │          │
    │              │              │          │              ├─ metric ──>│          │
    │              │              │          │              │            │          │
    │              │              │          │              ├─ alert ──>Telegram   │
    │              │              │          │              │            │          │
```

### Error Path: Risk Rejection

```
Polymarket        Signal          Dedup       Risk          Alert
    │              Module         Cache      Engine           │
    │                │              │          │              │
    ├─ trade ──────>│              │          │              │
    │              │ parse ──────>│          │              │
    │              │              │ hit? ──>│              │
    │              │<── no ────────│          │              │
    │              │              │          │<─ eval ─────│
    │              │              │          │ 6 guards    │
    │              │              │          │─ REJECTED ─>│
    │              │              │          │ (reason)    │
    │              │              │          │              ├─>Telegram
    │              │              │          │              │ "Risk guard blocked..."
    │              │              │          │              │
```

### Recovery: Bot Restart

```
SQLite       CLOB API        Position      Session       State
   │             │           Store         Tracker      Reconcile
   │             │              │             │            │
Start bot ────>│             │             │            │
   │  load events            │             │            │
   ├─────────>│             │             │            │
   │  replay  │             │             │            │
   │<─────────┼─ reconstruct ────────────>│            │
   │  replay  │             │<───── session state ─────┤
   │          │             │             │            │
   │          ├─ query open orders        │            │
   │          │ (conditionId/side match)  │            │
   │          │                           │            │
   │<───reconcile result ───┴──────────────────────────>│
   │          │             │             │            │
   │  if orphaned orders:   │             │            │
   │  ├─ log ORDER_FAILED   │             │            │
   │  └─ alert              │             │            │
   │          │             │             │            │
   │ Ready    │             │             │            │
   │          │             │             │            │
```

---

## Configuration Injection

```
.env file (user-provided)
  ├─ DRY_RUN
  ├─ TARGET_WALLETS
  ├─ COPY_STRATEGY
  ├─ COPY_RATIO
  ├─ Risk thresholds (MAX_NOTIONAL_PER_TRADE, MAX_MARKET_EXPOSURE, etc.)
  ├─ Notification webhooks (TELEGRAM_BOT_TOKEN, SLACK_WEBHOOK_URL)
  ├─ Live trading creds (POLYMARKET_API_KEY, PRIVATE_KEY, etc.)
  └─ LOG_LEVEL

src/index.ts
  ├─ Load env (Zod validation)
  ├─ Branch on DRY_RUN
  └─ Start bot with validated config
```

---

## Performance Characteristics

### Latency Budget (Signal → Order Submission)

| Stage | Target | Notes |
|-------|--------|-------|
| WS delivery | 100–300ms | Network (Polymarket → bot) |
| Trade filter + enrich | 10–50ms | Local parsing + cache lookup |
| Dedup cache check | <1ms | LRU lookup |
| Risk guard eval | 5–20ms | 6 sequential guards |
| Order builder | 1–5ms | Strategy + sizing |
| CLOB submission | 50–200ms | HTTP POST + network |
| **Total** | **<1s** | Target (median) |

### Memory Usage

| Component | Typical | Max |
|-----------|---------|-----|
| Dedup cache | 500 entries × 50 bytes | ~25 KB |
| Position store | ~100 positions × 200 bytes | ~20 KB |
| Signal backlog | <100 signals | ~50 KB |
| SQLite in-memory | <10 MB | Config-dependent |
| **Total** | **<100 MB** | Steady-state |

### Database I/O

- **SQLite writes:** <1ms per event (WAL mode, synchronous)
- **Frequency:** 1–10 events/sec (depends on signal volume)
- **Bottleneck:** Not I/O; network latency dominates

---

## Monitoring & Observability

### Metrics (logged every 5min)

```
{
  "type": "metrics_report",
  "latency_p50_ms": 450,
  "latency_p99_ms": 950,
  "orders_submitted": 42,
  "orders_filled": 38,
  "orders_failed": 1,
  "orders_rejected_risk": 3,
  "session_pnl_usd": -12.50,
  "session_drawdown_pct": 3.2,
  "balance_usd": 1987.50,
  "timestamp": 1716408000000
}
```

### Health Checks (every 60s)

```
WS staleness check:
  if (now - last_ws_event > 2min):
    → escalated alert ("⚠️ WS data stale")
    → fallback to REST polling

CLOB API ping:
  if (ping timeout > 5s):
    → alert ("⚠️ CLOB API slow")
    → continue with REST fallback
```

### Alerts (rate-limited 1x per 5min per severity+tag)

- **CRITICAL:** Bot startup failed, unrecoverable error
- **HIGH:** Drawdown halt, 5 order failures, WS down >5min
- **INFO:** Order submitted, order filled, guard rejection
- **DEBUG:** Signal received, guard eval, metrics snapshot

---

## Security Model

### Private Key Handling

- **Storage:** Environment variable only (`.env`, never logged)
- **Usage:** Ethers.js internally for CLOB signing
- **Redaction:** All logs strip key material

### API Credentials

- **CLOB:** API key + secret + passphrase (env vars)
- **Validation:** Asserted at startup for live mode
- **Scope:** Read + write orders on CLOB (no admin)

### Wallet Access

- **Signer:** Configured wallet derived from PRIVATE_KEY
- **Funds:** Max per-trade and per-session caps prevent runaway losses
- **Funder:** Optional proxy wallet (advanced use case)

---

## Deployment Topology

```
┌─────────────────────────────┐
│ Server (Ubuntu 20.04+)      │
│ ├─ Node.js 20.10+           │
│ ├─ polymarket-bot (app)     │
│ ├─ PM2 (process manager)    │
│ ├─ SQLite (local file)      │
│ └─ logs/ (JSON logs)        │
│                             │
│ .env (secrets)              │
│ polymarket.db (state)       │
│ logs/bot.log                │
│ node_modules (deps)         │
└──────┬──────────────────────┘
       │
       ├─>Polymarket RealTimeData WS
       ├─>Polymarket CLOB API
       ├─>Gamma API (fallback)
       ├─>Telegram (alerts)
       └─>Slack (alerts)
```

---

## Dependency Graph

```
index.ts (entry point)
  ├─ env-config.ts (Zod validation)
  │   └─ depends: zod, dotenv
  │
  ├─ (if DRY_RUN=true)
  │   └─ dry-run-runner.ts
  │       ├─ signal-emitter.ts
  │       ├─ ws-client.ts
  │       └─ market-enricher.ts
  │
  └─ (if DRY_RUN=false)
      └─ bot-orchestrator.ts
          ├─ clob-client-singleton.ts
          │   └─ ethers, @polymarket/clob-client
          ├─ signal-emitter.ts
          │   ├─ trade-filter.ts
          │   ├─ ws-client.ts
          │   └─ market-enricher.ts
          ├─ risk-engine.ts
          │   ├─ balance-guard.ts
          │   ├─ exposure-guard.ts
          │   ├─ drawdown-guard.ts
          │   └─ position-store.ts
          ├─ order-executor.ts
          │   ├─ order-builder.ts
          │   └─ dedup-cache.ts
          ├─ transaction-log.ts
          │   └─ better-sqlite3
          ├─ state-recovery.ts
          │   └─ clob-client-singleton.ts
          ├─ alert-notifier.ts
          ├─ health-checker.ts
          └─ metrics-tracker.ts
```

---

## Summary

The architecture prioritizes:
1. **Latency:** Sub-second signal → order flow
2. **Reliability:** Crash-safe state via SQLite + automatic recovery
3. **Modularity:** 7 independent components with clear boundaries
4. **Observability:** Real-time metrics + Telegram/Slack alerts
5. **Safety:** 6-tier risk guards + deduplication + circuit breaker
