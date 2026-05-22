# Phase 4: Risk Management Layer

**Status:** pending | **Priority:** high

## Overview

Guards that run synchronously before every order submission. Fast enough to add <2ms latency while preventing catastrophic losses.

## Architecture

```
src/risk/
├── risk-engine.ts          # Orchestrates all guards, returns approve/reject
├── exposure-guard.ts       # Per-market + session notional caps
├── drawdown-guard.ts       # Halt trading on max drawdown breach
└── balance-guard.ts        # Ensure sufficient USDC before submitting
```

## Risk Rules

| Guard | Limit | Action on breach |
|-------|-------|-----------------|
| Per-trade max | `MAX_NOTIONAL_PER_TRADE` (env) | Reduce size to cap |
| Per-market exposure | `MAX_MARKET_EXPOSURE` (env, default $500) | Reject order |
| Session notional | `MAX_SESSION_NOTIONAL` (env, default $5000) | Halt all trading |
| Max drawdown | 15% of session start balance | Halt 24h |
| Min order size | $1 USDC | Reject silently |
| Stale signal | >10s old | Reject (market moved) |

## Risk Engine Interface

```typescript
interface RiskDecision {
  approved: boolean;
  adjustedSize?: number;    // May reduce size instead of reject
  reason?: string;          // Log reason on rejection
}

async function evaluate(signal: TradeSignal, proposedSize: number): Promise<RiskDecision>
```

## Implementation Steps

1. **Risk engine** (`src/risk/risk-engine.ts`)
   - Run guards in order: staleness → balance → exposure → drawdown
   - First rejection short-circuits (no need to run all guards)
   - Return `{ approved, adjustedSize, reason }`
   - All guard calls must complete in <2ms total (in-memory only, no I/O)

2. **Exposure guard** (`src/risk/exposure-guard.ts`)
   - Read current positions from state store (in-memory, O(1))
   - Check per-market notional: `existingPosition.size + proposedSize ≤ maxMarket`
   - Check session total: `sessionNotional + proposedSize ≤ maxSession`
   - On breach: reject (don't partially fill — keep logic simple)

3. **Drawdown guard** (`src/risk/drawdown-guard.ts`)
   - Track `sessionStartBalance` (set at bot startup)
   - Compute current P&L from state store
   - If `(currentBalance - sessionStartBalance) / sessionStartBalance < -0.15`: halt
   - Halt = set `haltUntil = Date.now() + 24 * 3600 * 1000`, reject all orders
   - Alert via monitoring channel on halt

4. **Balance guard** (`src/risk/balance-guard.ts`)
   - Cached USDC balance, refreshed every 30s from CLOB API
   - Reject if `proposedSize > cachedBalance * 0.95`
   - On refresh failure: use last known balance (conservative)

## Files to Create

- `src/risk/risk-engine.ts`
- `src/risk/exposure-guard.ts`
- `src/risk/drawdown-guard.ts`
- `src/risk/balance-guard.ts`

## Todo

- [ ] Implement risk engine orchestrator
- [ ] Implement staleness check (signal.timestamp + 10000 < Date.now())
- [ ] Implement per-market exposure guard (reads from state store)
- [ ] Implement session notional accumulator
- [ ] Implement drawdown halt with 24h recovery
- [ ] Implement balance cache with 30s refresh
- [ ] Emit `'riskHalt'` event on drawdown breach → monitoring picks up
- [ ] Unit test each guard independently with edge cases

## Success Criteria
- All guards execute in <2ms combined
- Drawdown halt fires correctly at 15% loss
- Stale signals (>10s) always rejected
- Balance guard never allows over-commitment

## Security Considerations
- All limits configurable via env — no hardcoded magic numbers
- Halt state persisted to SQLite so restart doesn't reset it (phase 5)
- Never log private key or balance details at INFO level
