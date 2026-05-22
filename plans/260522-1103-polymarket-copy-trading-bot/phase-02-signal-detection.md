# Phase 2: Signal Detection Engine

**Status:** pending | **Priority:** critical

## Overview

Real-time detection of target wallet trades via Polymarket WebSocket feeds. This is the latency-critical path — every millisecond saved here directly reduces copy lag.

## Architecture

```
src/signal/
├── polymarket-ws-client.ts     # WebSocket connection manager (reconnect, keepalive)
├── trade-feed-parser.ts        # Parse raw WS messages → TradeSignal
├── wallet-trade-filter.ts      # Filter events by target wallet addresses
└── signal-emitter.ts           # EventEmitter that downstream subscribes to
```

## Key Insights from Research

- **Recommended approach:** `@polymarket/real-time-data-client` WebSocket, subscribe to activity feed
- **Fallback:** Polymarket Data API REST polling (`GET /data-api/v2/trades?maker={wallet}`) every 2s
- **Latency target:** WebSocket delivers events in <100ms; our parsing adds <5ms
- **No gas cost** — Polymarket orders are EIP-712 signed off-chain, matched off-chain, settled on-chain later

## WebSocket Strategy

```typescript
// Primary: Real-Time Data Service WebSocket
// Endpoint: wss://data-api.polymarket.com
// Subscribe to: {type: "trade", maker: targetWallet}

// On each trade event:
// 1. Parse event (< 1ms)
// 2. Filter by target wallet (< 0.1ms)
// 3. Emit TradeSignal (< 0.1ms)
// Total signal processing: < 2ms
```

## TradeSignal Type

```typescript
interface TradeSignal {
  id: string;              // Polymarket trade ID (dedup key)
  sourceWallet: string;    // Trader being copied
  conditionId: string;     // Market condition ID
  tokenId: string;         // YES/NO token
  side: 'BUY' | 'SELL';
  price: number;           // 0–1 (probability)
  size: number;            // USDC size of original trade
  timestamp: number;       // Unix ms (for latency tracking)
  detectedAt: number;      // Our receipt timestamp
}
```

## Implementation Steps

1. **WebSocket client** (`src/signal/polymarket-ws-client.ts`)
   - Connect to Polymarket real-time feed
   - Exponential backoff reconnect (100ms → 200ms → 400ms → max 30s)
   - Heartbeat ping every 30s
   - Emit `connected`, `disconnected`, `message` events

2. **Trade feed parser** (`src/signal/trade-feed-parser.ts`)
   - Parse raw JSON message
   - Validate required fields (conditionId, maker, side, price, size)
   - Return `TradeSignal | null` (null = not a trade event)

3. **Wallet filter** (`src/signal/wallet-trade-filter.ts`)
   - Normalize addresses to lowercase
   - Check if `maker` in target wallet set (O(1) Set lookup)

4. **Signal emitter** (`src/signal/signal-emitter.ts`)
   - Thin EventEmitter wrapper
   - Emits `'trade'` with `TradeSignal`
   - Logs signal receipt with latency (`detectedAt - timestamp`)

5. **Fallback polling** (inside ws-client)
   - If WS disconnected > 5s, start REST polling every 2s
   - Stop polling immediately on WS reconnect

## Files to Create

- `src/signal/polymarket-ws-client.ts`
- `src/signal/trade-feed-parser.ts`
- `src/signal/wallet-trade-filter.ts`
- `src/signal/signal-emitter.ts`

## Todo

- [ ] Implement WebSocket client with reconnect + keepalive
- [ ] Implement trade feed parser with validation
- [ ] Implement wallet address filter (lowercase normalization)
- [ ] Wire signal emitter
- [ ] Add REST polling fallback
- [ ] Log per-signal latency (WS timestamp → detectedAt)
- [ ] Test: mock WS server sending synthetic trade events

## Success Criteria
- Trade signal detected within 150ms of Polymarket publishing it
- Reconnects automatically within 5s of disconnect
- Dedup: same trade ID never emitted twice
- Fallback polling activates when WS down

## Risk Assessment
- **WS instability**: mitigated by reconnect + polling fallback
- **Missing trades during disconnect gap**: poll fills the gap
- **Wrong wallet match**: lowercase normalization prevents false negatives
