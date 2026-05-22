# Polymarket Technical Research Report
## Copy Trading Bot Architecture & Implementation

**Date:** 2026-05-22 | **Context:** TypeScript/Node.js bot targeting Polygon network  
**Status:** COMPLETED

---

## Executive Summary

Polymarket uses a **hybrid order execution model**: off-chain CLOB (Central Limit Order Book) matching for speed + on-chain Polygon settlement for security. Orders are EIP-712 signed (gasless), matching happens centrally, settlement is atomic on Polygon. Copy trading requires real-time trade detection (WebSocket preferable), fast order submission (L2 API credentials), and position tracking across the Data API.

**Key architectural decisions:**
- Use `@polymarket/clob-client-v2` (latest) for TypeScript/Node.js, not deprecated v1
- WebSocket subscriptions (not polling) for trade detection and orderbook updates
- L2 HMAC-signed requests for trading (after L1 EIP-712 credential derivation)
- Polygon RPC: QuickNode preferred for latency (86ms avg, 45ms US)
- Rate limits: 60 orders/minute per API key; implement exponential backoff on HTTP 429

---

## 1. Polymarket CLOB API: REST + WebSocket

### 1.1 Three-Tier API Architecture

| API | Base URL | Purpose | Auth Required |
|-----|----------|---------|---|
| **Gamma API** | `https://gamma-api.polymarket.com` | Markets, events, tags, discovery | No |
| **Data API** | `https://data-api.polymarket.com` | User positions, trades, activity, leaderboards | No |
| **CLOB API** | `https://clob.polymarket.com` | Orderbook, pricing, order placement/cancellation | Partial (read is public, write requires L2) |

### 1.2 Key REST Endpoints for Copy Trading

**Market Data (No Auth):**
- `GET /markets` — List all markets
- `GET /markets/{conditionId}` — Single market details (price, spread, volume)
- `GET /market/{conditionId}/trades` — Historical trade stream for a market
- `GET /orders/{conditionId}` — Current orderbook (bids/asks) for a market

**User Data (No Auth, but use Data API):**
- `GET /trades?user=0x{address}` (Data API) — User's trade history
- `GET /positions?user=0x{address}` (Data API) — Current open positions by market

**Order Management (Requires L2 Auth):**
- `POST /order` — Submit a single order
- `POST /orders` — Batch order submission (1,000 burst limit/10s)
- `DELETE /order/{orderId}` — Cancel order
- `GET /order` — Get order status/history
- `GET /account` — Wallet balance & collateral

### 1.3 WebSocket Real-Time Feeds

**Two WebSocket Services:**

1. **CLOB WebSocket** (`wss://ws-subscriptions-clob.polymarket.com/ws`)
   - Market channel (public, no auth): Order book updates, mid-price, last trade
   - User channel (L2 auth required): Your order fills, cancellations
   - Payload: order book snapshots, trade events, price ticks
   - Keep-alive: Send PING every 10s, server responds PONG

2. **Real-Time Data Service** (`wss://ws-live-data.polymarket.com`)
   - Broader market activity feed
   - Subscribe with `topic: "activity"`, `type: "trades"`
   - Available: `@polymarket/real-time-data-client` TypeScript wrapper

**Subscription Example (CLOB Market Channel):**
```json
{
  "action": "subscribe",
  "market": ["0x...conditionId"],
  "assets_ids": ["0x..."]
}
```

**Response includes:**
- Last trade price & size
- Bid/ask levels with volumes
- Spread (maker opportunity)
- Timestamp for latency tracking

---

## 2. Official SDKs & Libraries

### 2.1 TypeScript: @polymarket/clob-client-v2 (LATEST)

**NPM Package:** [`@polymarket/clob-client-v2`](https://www.npmjs.com/package/@polymarket/clob-client-v2)  
**GitHub:** [Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2)  
**Status:** Active maintenance, published 4 days ago (as of May 2026)  
**Deprecation Note:** v1 (`@polymarket/clob-client`) is deprecated; migrate to v2.

**Installation:**
```bash
npm install @polymarket/clob-client-v2 ethers
```

**Key Classes & Methods:**

```typescript
// Core client
import { ClobClient } from "@polymarket/clob-client-v2";

// L1 Authentication: Get API credentials
const clobClient = new ClobClient(
  { signer: ethersWallet },  // EIP-712 signer
  chainId: 137,              // Polygon
  clpAddress: "0x...",       // Conditional Logic Product address
);
const { apiKey, secret, passphrase } = 
  await clobClient.deriveOrCreateApiKey();

// L2 Auth: Subsequent requests use these credentials
const l2Client = new ClobClient(
  { apiCredentials: { apiKey, secret, passphrase } },
  chainId: 137,
);

// Order placement
const order = {
  token_id: "0x...",
  price: "0.65",
  size: "100",
  side: "BUY",  // or "SELL"
};
const orderHash = await l2Client.postOrder(order);

// Order cancellation
await l2Client.cancelOrder({ orderId: orderHash });

// Get position
const position = await l2Client.getPosition({ 
  token_id: "0x..." 
});

// Account balance
const balance = await l2Client.getBalance();
```

**Trade Detection:**
Use WebSocket client (separate package) for real-time trade events:
```typescript
import { RealTimeDataClient } from "@polymarket/real-time-data-client";
const rtClient = new RealTimeDataClient();
rtClient.subscribe({ topic: "activity", type: "trades" }, (trade) => {
  console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
});
```

### 2.2 Python: py-clob-client

**GitHub:** [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client)  
**Status:** Maintained by Polymarket core team  
**Use Case:** Reference implementation, data analysis workflows

Not recommended for primary bot (lower throughput than Node.js), but useful for backtesting and analytics.

### 2.3 Other Notable Libraries

- **Real-Time Data Client** (TypeScript): [`@polymarket/real-time-data-client`](https://github.com/Polymarket/real-time-data-client) — WebSocket wrapper with auto-reconnect
- **Rust CLOB Client** ([rs-clob-client](https://github.com/Polymarket/rs-clob-client)): For high-performance systems, not TypeScript
- **OctoBot Integration**: [OctoBot-Prediction-Market](https://github.com/Drakkar-Software/OctoBot-Prediction-Market) — Full bot framework (Python-based, may lack performance)

---

## 3. Order Execution Flow

### 3.1 Order Types: Limit vs. Market

**All orders on Polymarket are limit orders.** "Market orders" are simply limit orders with price set to cross the spread immediately.

| Order Type | Mechanism | Use Case |
|---|---|---|
| **Limit** | Specify price + size; rests on book until matched | Copy trading: match exact price from target |
| **Market (aggressive limit)** | Limit order priced to cross bid/ask immediately | Urgent execution; accepts slippage |
| **Post-Only** | Rejects if would match immediately (maker-only) | Liquidity provision, avoid taker fees |

### 3.2 Execution Pipeline: Off-Chain Match + On-Chain Settlement

```
1. Sign Order (EIP-712)
   ↓
2. Submit to CLOB Operator
   ↓
3. Matching Engine: Order book match (off-chain, <100ms)
   ↓
4. Atomic Settlement (Polygon, 1-2 block confirmation)
   ↓
5. Position Updated (Data API reflects immediately)
```

**Key Properties:**
- **Signature-based**: No private key held by Polymarket; trades are user-authorized via EIP-712
- **Gasless for users**: Polymarket relayer pays gas for settlement; all operations (deploy, approve, split, merge, redeem) are gasless
- **Conditional tokens**: Settlement happens via Conditional Logic Product (CLP) smart contract; splitting/merging doesn't happen on-chain unless explicitly called

### 3.3 Latency Profile

| Stage | Latency | Notes |
|---|---|---|
| Order signing (local) | 50-200ms | ethers.js wallet signing |
| HTTP POST to CLOB | 100-500ms | Network + Polymarket ingress |
| Matching (off-chain) | 10-50ms | Operator matching engine |
| Polygon settlement | 2,000-6,000ms | 2-4 blocks @ ~2 seconds/block |
| **Total end-to-end** | **2.2-7 seconds** | Dominated by Polygon confirmation |

For **copy trading**, target <500ms order submission to minimize slippage vs. target trader's fill time.

---

## 4. Polygon Network: RPC Providers & Gas Strategy

### 4.1 RPC Provider Latency Comparison

**Latest Benchmarks (2026):**

| Provider | Avg Latency | US Latency | EU Latency | Notes |
|---|---|---|---|---|
| **Uniblock** | 20-35ms | 15-20ms | 25-30ms | Multi-provider routing (fastest) |
| **QuickNode** | 86ms | 45ms | 74ms | Dedicated infra, premium tier |
| **Alchemy** | 207ms | 115ms | 133ms | Deprecated Blast API (Oct 2025) |
| **Infura** | ~150ms | N/A | N/A | Legacy option, slower |
| **Ankr** | 164ms | N/A | N/A | Balanced pricing |

**Recommendation for Copy Trading:**
- **Primary:** Uniblock (multi-provider failover, lowest latency)
- **Fallback:** QuickNode (reliable, predictable performance, good tier pricing)
- **Avoid:** Alchemy, Infura (higher latency for time-sensitive trading)

### 4.2 Gas Strategy for Polygon

**Compute Unit (CU) Pricing** (Alchemy/QuickNode model):
- Simple call (balance, nonce): 1 CU
- Standard tx (transfer, swap): 5-10 CU
- Complex query (logs, storage): 50-75 CU

**Cost Effective Approach:**
1. Use **Dwellir** or **Chainstack** for flat-rate pricing (~$2-2.50/1M requests)
2. Batch reads where possible (e.g., fetch multiple positions in one call)
3. Use **eth_call** (off-chain simulation) to validate orders before posting
4. Monitor gas prices: Polygon avg 1-5 GWEI (much cheaper than Ethereum)

**For Polymarket Specifically:**
- Polymarket pays gas for all settlement (deploy, approve, redeem)
- Bot only pays gas for position splits/merges (if needed) — optional
- No gas cost for order submission (EIP-712 signature, off-chain CLOB matching)

---

## 5. Authentication: L1 (EIP-712) → L2 (HMAC-SHA256)

### 5.1 Two-Level Flow

**Level 1: Private Key Signing (One-time)**
```typescript
// Wallet signs structured EIP-712 message to prove ownership
const signature = await wallet.signMessage(
  ethers.getAddress(userAddress)
);
// Server returns: { apiKey, secret, passphrase }
```

**Level 2: API Credentials (Per-request)**
```typescript
// For every authenticated request, compute HMAC signature:
const POLY_SIGNATURE = HMAC-SHA256(
  key = secret,
  message = `${timestamp}${method}${path}${body}`
);

// Include 5 headers with every request:
headers: {
  "POLY_ADDRESS": userAddress,        // Your signer
  "POLY_API_KEY": apiKey,              // From L1
  "POLY_PASSPHRASE": passphrase,       // From L1
  "POLY_TIMESTAMP": timestamp,         // Unix seconds
  "POLY_SIGNATURE": signature,         // HMAC-SHA256
}
```

### 5.2 Implementation Pattern

```typescript
// With SDK (automatic):
const apiCreds = await clobClient.deriveOrCreateApiKey();
const authedClient = new ClobClient({
  apiCredentials: apiCreds
});
await authedClient.postOrder(order); // Headers added automatically

// Raw HTTP (manual):
import crypto from "crypto";
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify(order);
const signature = crypto
  .createHmac("sha256", secret)
  .update(`${timestamp}POST/order${body}`)
  .digest("base64");
```

### 5.3 Key Management

- **L1 Secret:** Store private key in hardware wallet or secure vault (used once per session)
- **L2 Secrets:** Store `apiKey`, `secret`, `passphrase` in environment variables or secrets manager
- **Rotation:** Derive new L2 credentials periodically (weekly) to minimize exposure window
- **Best Practice:** Use separate API credentials per bot instance (one key per market/strategy)

---

## 6. Rate Limits & Throttling

### 6.1 CLOB API Rate Limits

**General Endpoints:**
- `GET /markets`, `GET /orderbook`: 15,000 requests / 10 seconds (global)
- CLOB general: 9,000 requests / 10 seconds (global)

**Trading-Specific Endpoints (per API key):**

| Endpoint | Burst (10s) | Sustained (10min) | Avg Rate |
|---|---|---|---|
| `POST /order` | 3,500 | 36,000 | 60 orders/min |
| `DELETE /order` | 3,000 | 30,000 | 50 cancellations/min |
| `POST /orders` (batch) | 1,000 | 15,000 | 25 orders/min |
| `DELETE /orders` (batch) | 1,000 | 15,000 | 25 cancellations/min |

**WebSocket:** No formal rate limits; subscription-based cost (few concurrent streams OK).

### 6.2 Rate Limit Enforcement

**Behavior:** Requests hitting the limit are **delayed/queued by Cloudflare**, not immediately rejected. HTTP 429 responses are rare unless severely over quota.

**Backoff Strategy for Copy Trading:**
```typescript
import pRetry from "p-retry";

const submitOrder = async (order) => {
  return pRetry(
    async (attempt) => {
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(`Retry ${attempt} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
      return await client.postOrder(order);
    },
    { retries: 5, minTimeout: 100, maxTimeout: 30000 }
  );
};
```

### 6.3 Optimization for High-Frequency Copy Trading

- **One WebSocket connection** per market (not per trade)
- **Batch order submission** when copying multiple trades from same signal
- **Avoid polling**: Use WebSocket + trade event subscriptions instead
- **Cache market data**: Keep orderbook in-memory; update incrementally from WebSocket deltas

---

## 7. Real-Time Trade Detection

### 7.1 Trade Detection Approaches

| Approach | Latency | Cost | Best For |
|---|---|---|---|
| **WebSocket (CLOB)** | <100ms | None (free) | Market channel trade feed; **RECOMMENDED** |
| **WebSocket (RTDS)** | 100-500ms | None (free) | Broad activity; good for volume tracking |
| **Polling GET /trades** | 1-2 seconds | Rate limit hit quickly | Fallback; not suitable for copy trading |
| **On-chain event logs** | 12+ seconds | RPC cost | Settlement verification; too slow |

### 7.2 Recommended: WebSocket Trade Feed

**Connection:**
```typescript
const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws");

ws.onopen = () => {
  // Subscribe to market trades + orderbook
  ws.send(JSON.stringify({
    action: "subscribe",
    market: ["0x...targetMarketId"],
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "trade") {
    console.log(`Trade: ${data.side} ${data.size} @ ${data.price}`);
    // Trigger copy order here
  } else if (data.type === "orderbook") {
    console.log(`Bid: ${data.bids[0]}, Ask: ${data.asks[0]}`);
  }
};
```

### 7.3 Real-Time Data Client (Official)

```typescript
import { RealTimeDataClient } from "@polymarket/real-time-data-client";

const client = new RealTimeDataClient();
client.connect();

client.subscribe({
  topic: "activity",
  type: "trades",
  assets: ["0x...tokenId"]
}, (trade) => {
  console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
});

// Auto-reconnect, handle disconnects
client.on("disconnected", () => {
  console.log("Reconnecting...");
  client.reconnect();
});
```

### 7.4 Latency Pipeline for Copy Trading

```
Target Trade Executed
  ↓ (T+0, on Polymarket order book)
WebSocket broadcasts trade event
  ↓ (T+50ms, bot receives)
Parse trade, validate copy criteria
  ↓ (T+50-100ms, bot logic)
Sign + submit copy order
  ↓ (T+150-200ms, CLOB ingress)
Matching engine processes
  ↓ (T+200-250ms, off-chain match)
Polygon settlement begins
  ↓ (T+2,000-6,000ms, on-chain blocks)
Position confirmed on bot's account
```

**Total:** ~2.2-7 seconds end-to-end, but **copy price captured in first 100ms**.

---

## 8. Known Open-Source Bots & Projects

### 8.1 Production-Quality Bots

**OctoBot-Prediction-Market** ([GitHub](https://github.com/Drakkar-Software/OctoBot-Prediction-Market))
- Full-featured bot framework for copy trading + arbitrage
- Auto-mirrors target wallet trades
- Python-based (may require optimization for latency)
- Status: Actively maintained

**Polymarket Copy Trading Bot** ([Orbital-Alpha/polymarket-copy-trading-bot](https://github.com/Orbital-Alpha/polymarket-copy-trading-bot))
- Specialized for 5-minute BTC Up/Down arbitrage
- Wallet-following module included
- Features: CLOB auth, WebSocket orderbook tracking, risk caps, circuit breakers
- Structured logging, graceful shutdown
- Status: Good reference implementation

**Polymarket Trading Bot** ([Menna-Awad11](https://github.com/Menna-Awad11/polymarket-trading-bot))
- Full credential management, real-time analysis
- Status: Community-maintained

### 8.2 Reference Libraries

**Polymarket Agent Skills** ([GitHub](https://github.com/Polymarket/agent-skills))
- Official patterns: authentication, order execution, trade detection
- Useful for understanding Polymarket's recommended patterns
- Not a bot framework, but best-practices reference

**Polymarket's Own Tools** ([PolyScripts](https://github.com/PolyScripts))
- Utility scripts, data export tools
- Useful for backtesting data extraction

---

## 9. Architecture Recommendations for Copy Trading Bot

### 9.1 Tech Stack

```
┌─────────────────────────────────────────┐
│ Application Layer (TypeScript/Node.js)   │
│  - Bot logic: trade detection, copying  │
│  - Position manager, risk controls      │
│  - Logging/monitoring                   │
├─────────────────────────────────────────┤
│ SDK Layer                                │
│  - @polymarket/clob-client-v2            │
│  - @polymarket/real-time-data-client     │
├─────────────────────────────────────────┤
│ Network Layer                            │
│  - WebSocket: CLOB (wss://...)           │
│  - REST: Data API, Gamma API             │
│  - Polygon RPC: Uniblock/QuickNode       │
├─────────────────────────────────────────┤
│ Infrastructure                           │
│  - Secrets: environment vars or HashiCorp Vault │
│  - Monitoring: Prom + Grafana            │
│  - Logs: Structured JSON (pino/winston)  │
└─────────────────────────────────────────┘
```

### 9.2 Key Implementation Patterns

**1. Single WebSocket connection per market** (no polling)
```typescript
const markets = ["0xMarketId1", "0xMarketId2"];
const ws = new WebSocket(WS_URL);
// Subscribe to all markets once on connection
markets.forEach(m => ws.send(subscribe(m)));
```

**2. Derived API key + secure storage**
```typescript
// On first run (one-time)
const creds = await signer.deriveOrCreateApiKey();
// Store in secrets manager (NOT git)
fs.writeFileSync(".env.local", `POLY_SECRET=${creds.secret}`);
// Subsequent runs: load from env
const client = new ClobClient({ apiCredentials: loadEnv() });
```

**3. Rate limit awareness**
```typescript
// Queue trades to respect 60/min per key
const orderQueue = new PQueue({ interval: 60000, intervalCap: 60 });
ws.on("trade", (trade) => {
  orderQueue.add(() => submitCopyOrder(trade));
});
```

**4. Position tracking + collateral management**
```typescript
// Track open positions in-memory (synced from API)
const positions = new Map(); // tokenId -> size
const balance = await client.getBalance();
if (balance.available < requiredForNextOrder) {
  console.warn("Insufficient collateral, pausing new trades");
  return;
}
```

---

## 10. Known Gaps & Unresolved Questions

1. **Exact Polygon block time variance** — Listed as 2-4 blocks @ 2s/block, but actual can vary 1-4 seconds. Affects total copy latency prediction.

2. **WebSocket connection stability** — How frequently do CLOB WebSocket connections drop? What is reconnection SLA? (Official docs don't specify MTBF/MTTR)

3. **Market-specific orderbook depth** — Not all markets have deep liquidity. What is typical bid/ask spread across Polymarket markets? Matters for slippage estimates.

4. **Multi-market copying** — If target trader trades 10 markets in <100ms, can one bot instance handle all 10 simultaneously? (Limited by rate limits + execution latency, but no explicit doc)

5. **Conditional token mechanics on-chain** — Polymarket uses Conditional Logic Product (CLP) smart contracts. Full settlement flow is somewhat obscure. How are split/merge/redeem gas costs calculated for larger positions?

6. **Rate limit header clarity** — Do X-RateLimit headers return remaining quota? Docs only mention HTTP 429. Would be useful for proactive backoff.

---

## Summary: Adoption Risk & Architectural Fit

### Maturity Assessment

| Component | Status | Risk | Notes |
|---|---|---|---|
| CLOB API | Production ✅ | Low | Polymarket's core product; battle-tested |
| clob-client-v2 SDK | Recent ✅ | Low | v1 deprecated but clean migration path |
| WebSocket feed | Stable ✅ | Low | Mature, widely used by traders |
| Polygon RPC | Mature ✅ | Medium | Non-Polymarket dependency; requires provider selection |
| Gasless auth (EIP-712) | Standard ✅ | Low | Industry standard, Polymarket relies on it |

### Architectural Fit for TypeScript/Node.js Copy Trading Bot

✅ **Strengths:**
- Lightweight SDK, minimal dependencies
- Non-custodial (user controls private key)
- Gasless trading (Polymarket covers settlement gas)
- Fast order matching (<100ms off-chain)
- WebSocket support native to Node.js
- Real-time data client available

⚠️ **Challenges:**
- Polygon settlement latency dominates (2-7 sec); can't be optimized
- Liquidity varies per market; slippage unpredictable
- Rate limits strict (60 orders/min); not suitable for 100+ simultaneous markets
- No atomic multi-leg orders (can't guarantee A fills if B doesn't); need circuit breakers

**Verdict:** Polymarket's architecture is **well-suited for copy trading** at moderate scale (1-10 simultaneous markets per bot instance). For high-frequency or multi-market coverage, consider horizontal scaling (multiple bot instances, each monitoring different markets + shared position coordinator).

---

## References

1. [Polymarket API Documentation](https://docs.polymarket.com/)
2. [Authentication - Polymarket Docs](https://docs.polymarket.com/developers/CLOB/authentication)
3. [Order Lifecycle - Polymarket Docs](https://docs.polymarket.com/concepts/order-lifecycle)
4. [Rate Limits - Polymarket Docs](https://docs.polymarket.com/api-reference/rate-limits)
5. [@polymarket/clob-client-v2 on npm](https://www.npmjs.com/package/@polymarket/clob-client-v2)
6. [Polymarket clob-client-v2 GitHub](https://github.com/Polymarket/clob-client-v2)
7. [Polymarket real-time-data-client GitHub](https://github.com/Polymarket/real-time-data-client)
8. [OctoBot-Prediction-Market GitHub](https://github.com/Drakkar-Software/OctoBot-Prediction-Market)
9. [Polymarket Copy Trading Bot - Orbital-Alpha](https://github.com/Orbital-Alpha/polymarket-copy-trading-bot)
10. [QuickNode Latency Benchmarks](https://blog.quicknode.com/justifying-quick-in-quicknode-response-time-comparison-of-various-blockchain-node-providers/)
11. [Uniblock RPC Latency Analysis](https://www.uniblock.dev/blog/latency-benchmarks-quicknode-vs-uniblock-vs-alchemy)
12. [Polymarket WebSocket Guide - AgentBets.ai](https://agentbets.ai/guides/polymarket-websocket-guide/)
13. [Polymarket Rate Limits Guide - AgentBets.ai](https://agentbets.ai/guides/polymarket-rate-limits-guide/)
14. [Polygon RPC Providers Comparison - Dwellir](https://www.dwellir.com/blog/10-best-polygon-providers-2025)
15. [How Polymarket Works - RockNBlock](https://rocknblock.io/blog/how-does-polymarket-work-the-tech-behind-prediction-markets)

