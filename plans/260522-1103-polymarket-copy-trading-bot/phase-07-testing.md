# Phase 7: Testing & Validation

**Status:** pending | **Priority:** high

## Overview

Unit tests for all business logic + integration tests against Polymarket's live API (read-only) to validate real behavior before deploying with real funds.

## Test Structure

```
tests/
├── unit/
│   ├── trade-feed-parser.test.ts       # Parse WS messages → TradeSignal
│   ├── order-builder.test.ts           # Size computation, FOK/GTC selection
│   ├── risk-engine.test.ts             # All guard combinations
│   ├── dedup-cache.test.ts             # LRU eviction + TTL expiry
│   ├── position-store.test.ts          # State transitions, exposure calc
│   └── state-recovery.test.ts          # Replay events → verify final state
└── integration/
    ├── polymarket-ws-client.test.ts    # Real WS connect, receive 1 message
    ├── polymarket-clob-read.test.ts    # Fetch real market data (no orders)
    └── full-pipeline.test.ts           # Signal → risk → order builder (dry-run)
```

## Unit Test Cases

### trade-feed-parser
- Valid trade event → correct TradeSignal fields
- Non-trade event (order book update) → returns null
- Missing required field → returns null (no throw)
- Price out of range (>1 or <0) → returns null

### order-builder
- Exact mirror: copySize === signal.size
- Proportional: copySize === signal.size * ratio
- Size capped at maxPerTrade
- Size capped at 95% of balance
- Size below $1 → returns null

### risk-engine
- Stale signal (>10s) → rejected
- Insufficient balance → rejected
- Market exposure exceeded → rejected
- Drawdown halt active → rejected
- All guards pass → approved
- Size adjusted down (near cap) → approved with adjustedSize

### dedup-cache
- Same trade ID within 5min → second call returns true (duplicate)
- Same trade ID after TTL expiry → second call returns false
- 501st entry evicts oldest

### position-store
- `addOpenOrder` → `getMarketExposure` includes order size
- `confirmFill` → order removed, position added
- `closePosition` → position removed, P&L returned

## Integration Test Cases

### WebSocket client (read-only, no orders)
- Connects to Polymarket real-time feed
- Receives at least 1 message within 30s
- Reconnects after forced disconnect

### CLOB API read-only
- Fetch market list → non-empty
- Fetch order book for active market → valid structure
- Auth headers accepted (API key valid)

### Full pipeline dry-run
- Mock WS emits synthetic TradeSignal for a configured target wallet
- Risk engine evaluates (passes all guards with small size)
- Order builder constructs valid order params
- Stop before actual submission (`DRY_RUN=true` env var skips POST)
- Verify log output contains correct latency breakdown

## Test Runner Setup

```bash
npm install --save-dev vitest @vitest/coverage-v8
```

```json
// package.json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

## Implementation Steps

1. Set up Vitest with TypeScript support
2. Write all unit tests (no network calls, no disk I/O)
3. Write integration tests with `DRY_RUN=true` guard
4. Add `npm run test` to pre-push hook (via package.json `prepare`)
5. Target: >80% coverage on `src/risk/`, `src/signal/parser`, `src/execution/order-builder`

## Files to Create

- `tests/unit/trade-feed-parser.test.ts`
- `tests/unit/order-builder.test.ts`
- `tests/unit/risk-engine.test.ts`
- `tests/unit/dedup-cache.test.ts`
- `tests/unit/position-store.test.ts`
- `tests/unit/state-recovery.test.ts`
- `tests/integration/polymarket-ws-client.test.ts`
- `tests/integration/polymarket-clob-read.test.ts`
- `tests/integration/full-pipeline.test.ts`
- `vitest.config.ts`

## Todo

- [ ] Configure Vitest + coverage
- [ ] Unit tests: parser, order builder, risk engine, dedup, state
- [ ] Integration tests: WS connect, CLOB read, dry-run pipeline
- [ ] Add `DRY_RUN` env flag to order executor (skip POST when set)
- [ ] Verify all unit tests pass with no network required
- [ ] Verify integration tests pass against live Polymarket API
- [ ] Coverage check: >80% on critical paths

## Success Criteria
- All unit tests pass in <5s (no network)
- Integration tests pass against live API (read-only)
- Dry-run pipeline test shows <300ms end-to-end latency in logs
- Zero test failures before any deployment
