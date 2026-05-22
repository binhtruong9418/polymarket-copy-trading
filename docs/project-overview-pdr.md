# Project Overview & Product Requirements

## Executive Summary

**Polymarket Copy-Trading Bot** is a TypeScript/Node.js application that automatically replicates trades from target Polygon wallets on Polymarket. Designed for ultra-low latency execution, it provides dry-run and live trading modes with configurable risk controls and real-time alerting.

**Status:** Production-ready v1.0.0 | Full feature set implemented

## Goals

### Primary
- **Real-time trade replication** – Detect target trades via public WebSocket within <1s
- **Flexible copy sizing** – Support exact and proportional strategies with per-trade caps
- **Risk-controlled execution** – Apply 6 sequential guards before order placement
- **State persistence** – Survive crashes with SQLite WAL and automatic recovery
- **Multi-channel alerts** – Notify via Telegram and Slack

### Secondary
- **Operational flexibility** – Easy dry-run mode for testing and validation
- **Performance transparency** – Track latency, fills, drawdown, and PnL
- **Developer velocity** – Modular 7-component architecture, <1600 LOC, zero runtime dependencies except core libs

## Non-Goals

- **Dynamic strategy switching** – All strategy parameters fixed at startup via env vars
- **Portfolio optimization** – No ML/backtesting; strictly rule-based replication
- **CEX integration** – Polymarket-only; no multi-exchange arbitrage
- **Custom indicator-based signals** – Only mirrors detected trades, no independent analysis
- **Web UI or API** – Headless bot only; configuration via env files

## Functional Requirements

### 1. Trade Detection
- **Input:** Public WebSocket (RealTimeDataClient) → activity/trades topic
- **Filtering:** By source wallet address (proxyWallet field in trade events)
- **Fallback:** REST polling (2s interval) if WebSocket disconnects
- **Deduplication:** LRU cache (500 entries, 5min TTL) to prevent duplicate orders
- **Enrichment:** Gamma API fallback for market metadata not in WS payload

### 2. Copy Sizing
- **Strategies:**
  - Exact: Copy exact USDC size from trade
  - Proportional: Scale by COPY_RATIO (0.01–1.0, e.g., 0.1 = 10% of trade)
- **Per-Trade Cap:** MAX_NOTIONAL_PER_TRADE (default 50 USDC)
- **Minimum:** Reject if adjusted size <$1 USDC
- **Precision:** 2 decimal places (USDC cents)

### 3. Risk Management (Sequential Guards)
1. **SELL Guard** – Reject BUY if no opposing SELL position in market
2. **Staleness Guard** – Reject if signal age >10 seconds
3. **Min Size Guard** – Reject if adjusted size <$1
4. **Balance Guard** – Cap to min(maxPerTrade, availableBalance × 0.95)
5. **Exposure Guard** – Reject if market allocation would exceed MAX_MARKET_EXPOSURE
6. **Drawdown Guard** – Halt all orders if session drawdown ≥MAX_DRAWDOWN_PCT (24h persistence across restarts)

### 4. Order Execution
- **Order Type:** GTC (Good-Till-Cancelled) limit orders via CLOB API
- **Price:** Exact price from copied trade
- **API:** createAndPostOrder with async/await + error handling
- **Circuit Breaker:** 5 consecutive failures → 60s pause before retry
- **Live Only:** Dry-run mode skips order placement entirely

### 5. State Management
- **Backend:** SQLite 3.x, WAL mode (synchronous writes, <1ms latency)
- **Schema:** Events table: type (enum), payload (JSON), ts (Unix ms)
- **Event Types:** ORDER_SUBMITTED, ORDER_FILLED, ORDER_FAILED, POSITION_CLOSED
- **Recovery:** Automatic replay on startup + reconciliation vs live CLOB API
- **Crash Safety:** All in-flight orders logged before submission

### 6. Monitoring & Alerts
- **Metrics:** P50/P99 latency, fill rate, session PnL, open positions
- **Alerts:** Telegram (primary) + Slack (secondary), rate-limited 1x per 5min per severity+tag
- **Health:** WS staleness >2min, CLOB API ping timeout → escalated alert
- **Logging:** Pino JSON logger with configurable level (trace–error)

### 7. Configuration
- **Entry Points:**
  - DRY_RUN=true → startDryRunRunner (no orders, Telegram only)
  - DRY_RUN=false → BotOrchestrator.start (live trading, requires CLOB creds)
- **Validation:** Zod schemas with runtime safety
- **Live Creds:** Required only for DRY_RUN=false; assertion at startup

## Non-Functional Requirements

### Performance
- **Trade Detection Latency:** <1s from Polymarket event to order submission
- **Order Execution:** <100ms CLOB API roundtrip (network-dependent)
- **State Write:** <1ms (SQLite WAL, synchronous mode)
- **Memory:** <100MB steady-state (Dedup cache 500 entries, in-memory ledger)

### Reliability
- **Uptime:** Graceful shutdown on SIGTERM; state survives restarts
- **Data Consistency:** No orphaned orders; event log is source of truth
- **Deduplication:** Exact transactionHash matching prevents double-orders
- **Fallback:** REST polling if WS down; alerts on health degradation

### Security
- **Secrets:** Private keys in env vars only (never logged)
- **API Keys:** CLOB credentials validated at startup
- **Wallet:** Proxy wallet support for advanced users
- **Funds:** Max per-trade and per-session caps prevent runaway losses

### Maintainability
- **Code Organization:** 7 modules, max 300 lines per file
- **Types:** Full TypeScript 5.8, no `any` types
- **Tests:** Vitest unit tests with >70% coverage target
- **Documentation:** Per-module inline docs + architecture diagrams

## Technical Constraints

### Platform
- **Runtime:** Node.js 20.10+ (ESM, no CommonJS)
- **Languages:** TypeScript 5.8 + JavaScript (transpiled via tsx)
- **Package Manager:** npm (package-lock.json committed)

### Dependencies
- **Core:** ethers v5, @polymarket/clob-client ^5.8.1, @polymarket/real-time-data-client ^1.4.0
- **Validation:** Zod ^3.25
- **Database:** better-sqlite3 ^11.10
- **Logging:** Pino ^9.7
- **Zero Runtime Overhead:** No ORM, no HTTP clients (ethers only), no heavy middleware

### Database
- **Engine:** SQLite 3.x (better-sqlite3)
- **Mode:** WAL (write-ahead logging) for concurrent reads
- **Data Retention:** Events kept for session (typically 24h)
- **Backup Strategy:** User-managed (copy .db file)

### APIs
- **Polymarket RealTimeData:** Public WebSocket (no auth needed)
- **Polymarket CLOB:** Authenticated (API key, secret, passphrase)
- **Gamma API:** Public (fallback for market metadata)
- **Telegram/Slack:** Webhooks (optional)

## Acceptance Criteria

### Done When
- [x] All 7 modules implemented and integrated
- [x] Dry-run mode fully functional (signals detected, no orders placed)
- [x] Live mode places real GTC orders via CLOB API
- [x] State recovery works: restart bot, open orders reconciled
- [x] All risk guards tested and blocking appropriate trades
- [x] Alerts fire on Telegram/Slack with 5min rate limit
- [x] Dedup cache prevents double-orders
- [x] Circuit breaker halts after 5 failures
- [x] TypeScript strict mode, no compilation errors
- [x] Unit tests pass with >70% coverage
- [x] Code lint clean (biome rules)
- [x] README + 6 doc files complete

### Success Metrics (Live Deployment)
- Copy trades within <1.5s of detection (median)
- <5% order rejection rate (risk guards expected)
- Zero orphaned orders after restart
- Drawdown stays within MAX_DRAWDOWN_PCT limits
- Alert latency <10s (Telegram delivery)

## Known Limitations & Future Work

### Current Limitations
- **Single-threaded:** Node.js event loop (adequate for <10 trades/sec throughput)
- **In-memory cache:** Dedup cache lost on restart (recoverable via transaction log)
- **Market selection:** All markets or hardcoded list; no dynamic filtering
- **Fees:** No explicit fee calculation; assumes USDC pricing stable

### Potential Enhancements (Out of Scope)
- [ ] Market-specific copy rules (e.g., only sports, skip low-liquidity)
- [ ] Dynamic ratio adjustment (e.g., reduce COPY_RATIO if drawdown >10%)
- [ ] Order size optimization based on liquidity
- [ ] PnL dashboard / web UI
- [ ] Multi-wallet copy routing
- [ ] Integration with other prediction markets

## Version History

| Version | Date | Status | Notes |
|---------|------|--------|-------|
| 1.0.0 | 2025-05-22 | Production | Full feature set |

## Glossary

| Term | Definition |
|------|-----------|
| Copy Rule | Config mapping target wallet → strategy, ratio, caps |
| Signal | Detected trade from target wallet (timestamp, side, size, price) |
| Dedup Cache | LRU cache (500 entries, 5min TTL) preventing duplicate orders |
| Guard | Sequential filter applied before order submission |
| Event | Logged trade outcome (ORDER_SUBMITTED, FILLED, FAILED, CLOSED) |
| WS | WebSocket (public Polymarket RealTimeData connection) |
| CLOB | Central limit order book (Polymarket trading engine) |
| GTC | Good-Till-Cancelled (order validity type) |
| Drawdown | Peak-to-trough session loss %; halts if ≥MAX_DRAWDOWN_PCT |
