# Phase 5: State Management & Persistence

**Status:** pending | **Priority:** high

## Overview

In-memory state for O(1) lookups during hot path, with SQLite as append-only transaction log for durability. Bot restarts recover full state from the log.

## Architecture

```
src/state/
├── position-store.ts       # In-memory positions + open orders map
├── session-tracker.ts      # Session P&L, notional accumulator, start balance
├── transaction-log.ts      # SQLite append-only write-ahead log
└── state-recovery.ts       # Rebuild in-memory state from SQLite on startup
```

## Data Model

```typescript
// In-memory
interface Position {
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;           // USDC
  avgPrice: number;
  openedAt: number;       // Unix ms
}

interface OpenOrder {
  orderId: string;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  submittedAt: number;
  sourceTradeId: string;  // dedup link
}

// SQLite schema
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,       -- 'ORDER_SUBMITTED' | 'ORDER_FILLED' | 'ORDER_FAILED' | 'POSITION_CLOSED'
  payload TEXT NOT NULL,    -- JSON
  ts INTEGER NOT NULL       -- Unix ms
);
```

## State Transitions

```
Signal received
  → ORDER_SUBMITTED → position_store.addOpenOrder()
  → ORDER_FILLED    → position_store.openPosition()
  → ORDER_FAILED    → position_store.removeOpenOrder()
  → POSITION_CLOSED → position_store.closePosition() + session_tracker.recordPnL()
```

## Implementation Steps

1. **Position store** (`src/state/position-store.ts`)
   - `Map<tokenId, Position>` for open positions
   - `Map<orderId, OpenOrder>` for pending orders
   - Methods: `addOpenOrder`, `confirmFill`, `removeOpenOrder`, `getMarketExposure(conditionId)`
   - `getMarketExposure` = sum of all positions + open orders for a conditionId (used by risk guard)

2. **Session tracker** (`src/state/session-tracker.ts`)
   - `sessionStartBalance: number` — set once at startup from CLOB API
   - `sessionNotional: number` — accumulated submitted size this session
   - `realizedPnL: number` — sum of closed position P&L
   - Methods: `addNotional(size)`, `recordPnL(pnl)`, `getDrawdown(currentBalance)`

3. **Transaction log** (`src/state/transaction-log.ts`)
   - `better-sqlite3` synchronous writes (faster than async for single-writer)
   - `appendEvent(type, payload)` — synchronous, <1ms per write
   - `readAllEvents()` — used only at startup for recovery

4. **State recovery** (`src/state/state-recovery.ts`)
   - On startup: read all events from SQLite in order
   - Replay each event to rebuild position store + session tracker
   - Validate final state against live CLOB API positions (reconcile discrepancies)
   - Log any mismatches as warnings

## Files to Create

- `src/state/position-store.ts`
- `src/state/session-tracker.ts`
- `src/state/transaction-log.ts`
- `src/state/state-recovery.ts`

## Todo

- [ ] Implement position store with O(1) maps
- [ ] Implement `getMarketExposure` (aggregates positions + open orders)
- [ ] Implement session tracker with drawdown computation
- [ ] Implement SQLite transaction log (better-sqlite3, WAL mode)
- [ ] Implement state recovery + live reconciliation on startup
- [ ] Test: replay 100 synthetic events → verify state matches expected
- [ ] Test: simulate crash mid-trade → restart → verify recovery

## Success Criteria
- State writes add <1ms to hot path
- Bot restart recovers full position state in <2s
- Live reconciliation catches any API/local discrepancy
- No position double-counted after recovery

## Risk Assessment
- **SQLite corruption**: WAL mode + integrity check on startup
- **State divergence**: live reconciliation from CLOB API on every restart
- **Memory growth**: positions map bounded by active markets (<1000 typical)
