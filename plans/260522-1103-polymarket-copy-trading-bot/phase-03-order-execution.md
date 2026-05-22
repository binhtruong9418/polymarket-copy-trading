# Phase 3: Order Execution Engine

**Status:** pending | **Priority:** critical

## Overview

Submit copy orders to Polymarket CLOB as fast as possible after receiving a TradeSignal. Uses `@polymarket/clob-client-v2` with pre-authenticated L2 headers to minimize per-order overhead.

## Architecture

```
src/execution/
├── polymarket-clob-client.ts   # Singleton CLOB client wrapper (pre-authed)
├── order-builder.ts            # Build limit order from TradeSignal + sizing rules
├── order-executor.ts           # Submit order, handle response, track state
└── dedup-cache.ts              # LRU cache for trade ID idempotency (5s window)
```

## Key Insights from Research

- All Polymarket orders are **limit orders** (no true market orders)
- Orders are **EIP-712 signed** — gasless, off-chain matching in <100ms
- **On-chain settlement** on Polygon takes 2–7s (irrelevant for our submission latency)
- L2 auth headers computed per-request via HMAC-SHA256 — pre-warm the client singleton
- **Rate limit: 60 orders/minute** per API key → ~1 order/second max

## Order Flow

```
TradeSignal received
    ↓ (< 1ms) dedup check
    ↓ (< 2ms) compute copy size
    ↓ (< 1ms) build EIP-712 order
    ↓ (< 5ms) sign with ethers wallet
    ↓ (< 100ms) POST to CLOB API
    ↓ log result + latency
Total: < 120ms to order submitted
```

## Copy Sizing Logic

```typescript
// Exact mirror: copySize = signal.size
// Proportional: copySize = signal.size * copyRatio
// Capped by: maxNotionalPerTrade, available balance

function computeCopySize(signal: TradeSignal, rule: CopyRule, balance: number): number {
  const base = rule.strategy === 'exact' ? signal.size : signal.size * rule.ratio;
  const capped = Math.min(base, rule.maxPerTrade, balance * 0.95);
  return Math.floor(capped * 100) / 100; // 2 decimal places
}
```

## Order Builder

```typescript
// Builds a limit order at signal.price (best-effort fill)
// For BUY: price = signal.price (willing to pay up to what they paid)
// For SELL: price = signal.price
// Side mapping: signal.side → Polymarket BUY/SELL token side

interface ClobOrder {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType: 'GTC' | 'FOK';  // Use FOK for aggressive fills
  expiration?: number;         // Unix seconds, 0 = no expiry
}
```

## Implementation Steps

1. **CLOB client singleton** (`src/execution/polymarket-clob-client.ts`)
   - Initialize once at startup with `ClobClient` from SDK
   - Pre-derive L2 credentials from private key (one-time cost)
   - Expose `placeOrder(order)` and `cancelOrder(id)` wrappers
   - Track consecutive failures; circuit-break after 5 failures in 60s

2. **Order builder** (`src/execution/order-builder.ts`)
   - Accept `TradeSignal + CopyRule + currentBalance`
   - Return `ClobOrder | null` (null if size below minimum ~$1)
   - Apply FOK for aggressive fills on liquid markets, GTC otherwise

3. **Order executor** (`src/execution/order-executor.ts`)
   - Check dedup cache first (skip if trade ID already processed)
   - Call order builder → validate size → sign → submit
   - On success: record to state store + log with full latency breakdown
   - On failure: log error, emit `'orderFailed'` event (risk layer handles)
   - Timeout: abort if CLOB API doesn't respond in 3s

4. **Dedup cache** (`src/execution/dedup-cache.ts`)
   - LRU Map with 5-minute TTL, keyed by `signal.id`
   - Max 500 entries (covers ~8 trades/s burst)
   - Also dedup by `(tokenId + side + price + size)` fingerprint to catch re-emitted signals

## Files to Create

- `src/execution/polymarket-clob-client.ts`
- `src/execution/order-builder.ts`
- `src/execution/order-executor.ts`
- `src/execution/dedup-cache.ts`

## Todo

- [ ] Implement CLOB client singleton with L2 auth pre-warm
- [ ] Implement copy sizing (exact + proportional modes)
- [ ] Implement order builder (limit/FOK selection)
- [ ] Implement order executor with 3s timeout
- [ ] Implement dedup LRU cache
- [ ] Add circuit breaker (5 failures → pause 60s)
- [ ] Log full latency: `signal.timestamp → detectedAt → submittedAt → confirmedAt`
- [ ] Test: simulate signal → verify order params before submitting

## Success Criteria
- Order submitted within 150ms of signal receipt (our processing adds <20ms)
- Duplicate signals never generate duplicate orders
- Failed orders don't crash the bot — emit event, continue
- Circuit breaker prevents runaway failures

## Risk Assessment
- **Rate limit (60/min)**: queue excess signals, drop if >10s stale
- **Stale price**: our limit order may not fill if market moved; acceptable for copy trading
- **API downtime**: circuit breaker + alerting handles this
- **Insufficient balance**: size computation caps to 95% of available balance
