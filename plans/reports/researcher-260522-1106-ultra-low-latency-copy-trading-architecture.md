# Ultra-Low-Latency Copy Trading Bot Architecture
## TypeScript/Node.js Technical Report

**Report Date:** 2026-05-22  
**Scope:** Polymarket copy trading bot — sub-100ms reaction time design  
**Target Latency:** 100–300ms signal-to-fill (realistic for Polymarket given WebSocket + RPC constraints)

---

## Executive Summary

Building a production-grade copy trading bot for Polymarket requires **layered optimization**: infrastructure isolation, event-driven messaging, persistent connections with backpressure handling, atomic order execution, and aggressive risk management. Node.js/TypeScript is viable **only** with disciplined architecture choices around async patterns, memory allocation, and worker thread usage. The research reveals three critical design choices:

1. **Event-driven core with async/await (not callbacks)** — Minimizes code complexity while Node.js single-threaded design handles I/O concurrency natively
2. **Persistent WebSocket + redundant HTTP polling** — WebSocket delivers 100–300ms updates; polling (2s interval) catches race conditions
3. **In-memory position cache with atomic trade recording** — Prevents duplicate fills and position overshoots

This report prioritizes **YAGNI** (don't build for arbitrage, MEV, or ML yet) and **KISS** (prefer simple async/await patterns over worker threads unless CPU-bound).

---

## 1. EVENT-DRIVEN ARCHITECTURE

### Pattern Recommendation: Async/Await with EventEmitter for Coordination

**Why Async/Await Over Callbacks or Worker Threads:**

- **Callbacks**: Hard to reason about control flow; promotes "callback hell" in trade-critical code
- **Worker Threads**: Adds complexity; only needed for CPU-intensive tasks (ML inference, strategy calculation), not I/O bottlenecks
- **Async/Await**: Readable, stacktrace-friendly, native error handling with try/catch

**Core Pattern:**

```typescript
// NOT this (callback hell):
detectTrade(trade => {
  validateRisk(trade, (err, valid) => {
    if (valid) submitOrder(trade, (err, order) => { ... })
  })
})

// YES this (async/await chain):
async function handleTradeSignal(trade: Trade) {
  try {
    const isValid = await validateRisk(trade)
    if (!isValid) return log.warn('trade rejected', trade.id)
    const order = await submitOrder(trade)
    await recordFill(order)
  } catch (err) {
    log.error('trade failed', { tradeId: trade.id, error: err.message })
  }
}
```

**EventEmitter for Coordination** (not data passing):

```typescript
// Central event bus for monitoring, alerting
const eventBus = new EventEmitter()

eventBus.on('trade:detected', (trade) => {
  metrics.increment('signal_count', { market: trade.market })
})

eventBus.on('trade:filled', (order) => {
  metrics.increment('fill_count')
  sendAlert('trade_filled', { orderId: order.id, size: order.size })
})

// In execution path:
await submitOrder(trade)
eventBus.emit('trade:filled', order) // Decouples metrics/alerts from core logic
```

**Anti-Pattern:** Using EventEmitter to pass order data between services. Use direct async function returns + typed channels instead.

---

## 2. WEBSOCKET MANAGEMENT

### Dual-Stream Strategy: WebSocket + Polling Fallback

**Why Dual Streams:**

- WebSocket: 100–300ms latency for real-time market updates
- Polling (2s interval): Catches trades when WebSocket has connection blips or is reconnecting

**WebSocket Implementation with `ws` Library:**

```typescript
import WebSocket from 'ws'
import pino from 'pino'

const log = pino()

class PolymarketWsClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000 // ms
  private subscriptions = new Set<string>()

  constructor(
    private apiKey: string,
    private apiSecret: string,
    private onMessage: (msg: any) => Promise<void>
  ) {}

  async connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket('wss://ws-api.polymarket.com', {
        handshakeTimeout: 10000, // Fail fast on timeout
        perMessageDeflate: false, // Reduce CPU overhead
      })

      this.ws.on('open', () => {
        log.info('ws:connected')
        this.reconnectAttempts = 0
        this.resubscribe()
        resolve()
      })

      this.ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())
          await this.onMessage(msg) // Async handler for order submission
        } catch (err) {
          log.error('ws:parse_error', { error: err.message })
        }
      })

      this.ws.on('error', (err) => {
        log.error('ws:error', { error: err.message })
      })

      this.ws.on('close', () => {
        log.warn('ws:closed', { attempt: this.reconnectAttempts })
        this.reconnect().catch(reject)
      })

      setTimeout(() => reject(new Error('ws:timeout')), 10000)
    })
  }

  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error('ws:max_reconnect_attempts_exceeded')
    }
    this.reconnectAttempts++
    await sleep(this.reconnectDelay * this.reconnectAttempts) // Exponential backoff
    return this.connect()
  }

  subscribe(channel: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.subscriptions.add(channel)
      return
    }
    this.subscriptions.add(channel)
    this.ws.send(JSON.stringify({ action: 'subscribe', channel }))
  }

  private resubscribe() {
    for (const channel of this.subscriptions) {
      this.ws?.send(JSON.stringify({ action: 'subscribe', channel }))
    }
  }

  unsubscribe(channel: string) {
    this.subscriptions.delete(channel)
    this.ws?.send(JSON.stringify({ action: 'unsubscribe', channel }))
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}
```

**Keep-Alive & Backpressure Handling:**

```typescript
class BackpressureHandler {
  private messageQueue: any[] = []
  private processing = false
  private maxQueueSize = 1000

  async enqueue(message: any) {
    if (this.messageQueue.length >= this.maxQueueSize) {
      log.warn('queue:overflow', { size: this.messageQueue.length })
      return false // Reject message; don't OOM
    }
    this.messageQueue.push(message)
    this.process()
    return true
  }

  private async process() {
    if (this.processing) return
    this.processing = true

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()
      try {
        await this.handleMessage(msg)
      } catch (err) {
        log.error('message:error', { error: err.message })
      }
    }

    this.processing = false
  }

  private async handleMessage(msg: any) {
    // Order submission logic here
  }
}
```

**Keep-Alive Pattern:**

```typescript
// Ping server every 30 seconds; close on no pong after 5s
const keepAlive = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.ping()
    const pongTimeout = setTimeout(() => {
      log.warn('ws:no_pong_timeout')
      ws.close() // Force reconnect
    }, 5000)

    ws.once('pong', () => clearTimeout(pongTimeout))
  }
}, 30000)
```

---

## 3. ORDER EXECUTION PIPELINE

### Signal-to-Fill Latency Breakdown

Realistic latency for Polymarket copy trading:

```
┌─────────────────────────────────────────────────┐
│ Signal Detection (WebSocket)        : 100–300ms │
├─────────────────────────────────────────────────┤
│ Parse + Risk Check                  :  5–10ms   │
├─────────────────────────────────────────────────┤
│ Size Calculation + Validation        :  2–5ms   │
├─────────────────────────────────────────────────┤
│ Order Submission (HTTP POST)         : 20–50ms  │
├─────────────────────────────────────────────────┤
│ Polymarket Fill Confirmation         : 50–150ms │
├─────────────────────────────────────────────────┤
│ TOTAL (P50)                          : ~180ms   │
│ TOTAL (P95)                          : ~500ms   │
└─────────────────────────────────────────────────┘
```

**Critical:** Signal detection via WebSocket is the bottleneck. HTTP/2 keep-alive matters less than ensuring WebSocket stays connected.

### Atomic Order Submission Pattern

```typescript
async function submitCopyOrder(
  targetTrade: Trade,
  botConfig: BotConfig
): Promise<Order | null> {
  const startTime = Date.now()
  const orderId = nanoid()

  try {
    // Phase 1: Risk validation (must be synchronous or very fast)
    const risk = await validateRisk(targetTrade, botConfig)
    if (!risk.allowed) {
      log.warn('order:rejected_risk', {
        tradeId: targetTrade.id,
        reason: risk.reason,
      })
      return null
    }

    // Phase 2: Calculate copy order size
    const copySize = calculateCopySize(targetTrade, botConfig)

    // Phase 3: Build order payload
    const order: OrderPayload = {
      token_id: targetTrade.token_id,
      side: targetTrade.side,
      size: copySize,
      price: targetTrade.price,
      order_type: 'FOK', // Fill-or-Kill to avoid partial fills
      signature: sign(order, botConfig.privateKey),
      timestamp: Date.now(),
    }

    // Phase 4: Submit with immediate timeout + retry
    const submitted = await submitWithTimeout(order, 2000) // 2s max

    // Phase 5: Record fill atomically (idempotency key = orderId)
    await recordFill({
      id: orderId,
      targetTradeId: targetTrade.id,
      order: submitted,
      submittedAt: new Date(),
      latency: Date.now() - startTime,
    })

    log.info('order:submitted', {
      orderId,
      latency: Date.now() - startTime,
      size: copySize,
    })

    return submitted
  } catch (err) {
    log.error('order:submission_failed', {
      orderId,
      error: err.message,
      latency: Date.now() - startTime,
    })
    // Don't throw; log and return null; let the signal detection retry
    return null
  }
}

async function submitWithTimeout(
  order: OrderPayload,
  timeoutMs: number
): Promise<Order> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch('https://clob.polymarket.com/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.POLYMARKET_API_KEY}`,
      },
      body: JSON.stringify(order),
      signal: controller.signal,
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(`API error: ${error.message}`)
    }

    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}
```

**Async vs Callbacks vs Streams:**

- **Async/Await**: Best for this workflow — readable, error handling is natural
- **Callbacks**: Harder to debug; would require promise wrapper anyway
- **Streams**: Overkill for single orders; use for bulk order feeds only

---

## 4. CONNECTION POOLING & RPC OPTIMIZATION

### HTTP/2 Keep-Alive for RPC Calls

```typescript
import https from 'https'

// Shared agent with connection pooling
const httpAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000, // 30s keep-alive interval
  maxSockets: 50, // Connection pool size
  maxFreeSockets: 10, // Keep 10 idle connections ready
  timeout: 30000, // Close unused sockets after 30s
})

const rpcPool = new Map<string, https.Agent>()

function getOrCreateAgent(endpoint: string): https.Agent {
  if (!rpcPool.has(endpoint)) {
    rpcPool.set(
      endpoint,
      new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 30,
      })
    )
  }
  return rpcPool.get(endpoint)!
}

async function fetchBalance(
  wallet: string,
  rpcEndpoint: string
): Promise<bigint> {
  const agent = getOrCreateAgent(rpcEndpoint)

  const response = await fetch(rpcEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: [wallet],
      id: 1,
    }),
    agent,
  })

  const data = await response.json()
  return BigInt(data.result)
}
```

**Anti-Pattern:** Creating a new HTTPS agent per request. Reuse agents; they're expensive to initialize.

**Fallback Routing:**

```typescript
class RpcRouter {
  private endpoints: string[] = [
    'https://rpc1.polymarket.com',
    'https://rpc2.polymarket.com',
  ]
  private latencies = new Map<string, number>()

  async call<T>(method: string, params: any[]): Promise<T> {
    const sorted = this.endpoints.sort(
      (a, b) => (this.latencies.get(a) ?? 999) - (this.latencies.get(b) ?? 999)
    )

    for (const endpoint of sorted) {
      try {
        const start = Date.now()
        const result = await this.fetchWithTimeout(endpoint, method, params, 5000)
        this.latencies.set(endpoint, Date.now() - start)
        return result
      } catch (err) {
        log.warn('rpc:endpoint_failed', { endpoint, error: err.message })
      }
    }

    throw new Error('rpc:all_endpoints_failed')
  }

  private async fetchWithTimeout(
    endpoint: string,
    method: string,
    params: any[],
    timeoutMs: number
  ): Promise<any> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: controller.signal,
      })
      return response.json()
    } finally {
      clearTimeout(timeout)
    }
  }
}
```

---

## 5. RISK MANAGEMENT LAYER

### Tiered Risk Control

```typescript
interface RiskConfig {
  // Per-bot session
  maxSessionNotional: number // USD cap for entire session

  // Per-market
  maxPerMarketNotional: number // USD cap per market
  maxPerMarketSize: number // Share count cap

  // Per-trade
  maxSlippage: number // % from midpoint
  maxOrderValue: number // USD per order

  // Portfolio heat
  maxPortfolioHeat: number // % of account at risk
  maxDrawdownBeforeHalt: number // % before pausing
}

class RiskManager {
  private sessionNotional = 0
  private marketNotional = new Map<string, number>()
  private activeOrders = new Map<string, Order>()
  private positions = new Map<string, Position>()
  private sessionStartTime = Date.now()

  async validateTrade(
    trade: Trade,
    config: RiskConfig
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Check 1: Session notional cap
    const tradeNotional = trade.price * trade.size
    if (this.sessionNotional + tradeNotional > config.maxSessionNotional) {
      return {
        allowed: false,
        reason: 'session_notional_exceeded',
      }
    }

    // Check 2: Per-market notional cap
    const marketCurrent = this.marketNotional.get(trade.market_id) ?? 0
    if (marketCurrent + tradeNotional > config.maxPerMarketNotional) {
      return {
        allowed: false,
        reason: 'per_market_notional_exceeded',
      }
    }

    // Check 3: Position doesn't exceed max per-market
    const currentPos = this.positions.get(trade.market_id) ?? { shares: 0 }
    if (
      currentPos.shares +
        trade.size *
          (trade.side === 'buy' ? 1 : -1) >
      config.maxPerMarketSize
    ) {
      return {
        allowed: false,
        reason: 'per_market_size_exceeded',
      }
    }

    // Check 4: Drawdown halt
    if (this.getSessionDrawdown() > config.maxDrawdownBeforeHalt) {
      return {
        allowed: false,
        reason: 'max_drawdown_exceeded',
      }
    }

    // Check 5: No duplicate fills (idempotency)
    if (this.isDuplicate(trade)) {
      return {
        allowed: false,
        reason: 'duplicate_trade_detected',
      }
    }

    return { allowed: true }
  }

  recordFill(trade: Trade, order: Order) {
    const notional = trade.price * trade.size
    this.sessionNotional += notional
    this.marketNotional.set(
      trade.market_id,
      (this.marketNotional.get(trade.market_id) ?? 0) + notional
    )

    const pos = this.positions.get(trade.market_id) ?? { shares: 0, avgPrice: 0 }
    pos.shares += trade.side === 'buy' ? trade.size : -trade.size
    pos.avgPrice =
      (pos.avgPrice * (pos.shares - trade.size) + trade.price * trade.size) /
      pos.shares
    this.positions.set(trade.market_id, pos)

    this.activeOrders.set(order.id, order)
  }

  private isDuplicate(trade: Trade): boolean {
    // Check if we've filled the same target trade in last 2 seconds
    // Use idempotency key (targetTradeId) to dedupe
    return false // Implementation: check recent fill history
  }

  private getSessionDrawdown(): number {
    // Estimate unrealized P&L; return % drawdown
    return 0 // Implementation: sum of mark-to-market losses
  }
}
```

**Duplicate Trade Prevention:**

```typescript
class DuplicateDetector {
  private recentFills = new LRUCache<string, Date>({
    max: 10000,
    ttl: 5000, // 5 second window
  })

  isFilled(targetTradeId: string): boolean {
    const lastFill = this.recentFills.get(targetTradeId)
    return lastFill !== undefined && Date.now() - lastFill.getTime() < 5000
  }

  markFilled(targetTradeId: string) {
    this.recentFills.set(targetTradeId, new Date())
  }
}
```

---

## 6. STATE MANAGEMENT

### In-Memory Position Cache with Atomic Updates

```typescript
interface Position {
  tokenId: string
  side: 'buy' | 'sell'
  shares: number
  avgPrice: number
  notional: number // total USD exposure
  lastUpdated: Date
}

interface PendingOrder {
  id: string
  tokenId: string
  size: number
  side: 'buy' | 'sell'
  submittedAt: Date
  status: 'pending' | 'filled' | 'failed'
}

class PositionState {
  private positions = new Map<string, Position>()
  private pendingOrders = new Map<string, PendingOrder>()
  private balance = 0
  private lock = new AsyncLock() // Prevent concurrent mutations

  async getPosition(tokenId: string): Promise<Position | undefined> {
    return this.positions.get(tokenId)
  }

  async recordFill(
    tokenId: string,
    side: 'buy' | 'sell',
    size: number,
    price: number
  ) {
    return this.lock.acquire('update', async () => {
      const pos = this.positions.get(tokenId) ?? {
        tokenId,
        side,
        shares: 0,
        avgPrice: 0,
        notional: 0,
        lastUpdated: new Date(),
      }

      const newShares = pos.shares + (side === 'buy' ? size : -size)
      const newAvgPrice =
        (pos.avgPrice * pos.shares + price * size * (side === 'buy' ? 1 : -1)) /
        newShares

      pos.shares = newShares
      pos.avgPrice = newAvgPrice
      pos.notional = Math.abs(newShares * newAvgPrice)
      pos.lastUpdated = new Date()

      this.positions.set(tokenId, pos)
      return pos
    })
  }

  async addPendingOrder(order: PendingOrder) {
    return this.lock.acquire('update', async () => {
      this.pendingOrders.set(order.id, order)
    })
  }

  async settlePendingOrder(orderId: string, status: 'filled' | 'failed') {
    return this.lock.acquire('update', async () => {
      const order = this.pendingOrders.get(orderId)
      if (order) {
        order.status = status
      }
    })
  }

  getSnapshot(): {
    positions: Position[]
    pendingOrders: PendingOrder[]
    totalNotional: number
  } {
    const positions = Array.from(this.positions.values())
    const totalNotional = positions.reduce((sum, p) => sum + p.notional, 0)
    return {
      positions,
      pendingOrders: Array.from(this.pendingOrders.values()),
      totalNotional,
    }
  }
}
```

**Why In-Memory (Not Database):**

- **Speed**: O(1) lookups, no query latency
- **Simplicity**: Reduces dependencies; easier to test
- **Risk**: Loss on bot crash → Mitigate with transaction log

**Durability Pattern:**

```typescript
class TransactionLog {
  private log: Transaction[] = []
  private logFile = './data/transactions.jsonl'

  async append(tx: Transaction) {
    this.log.push(tx)
    await fs.appendFile(
      this.logFile,
      JSON.stringify(tx) + '\n',
      'utf-8'
    )
  }

  async recover(): Promise<Transaction[]> {
    try {
      const content = await fs.readFile(this.logFile, 'utf-8')
      return content
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    } catch (err) {
      return []
    }
  }
}
```

**On startup:**
```typescript
async function startup() {
  const txLog = new TransactionLog()
  const recoveredTxs = await txLog.recover()

  // Rebuild position state from transaction log
  const state = new PositionState()
  for (const tx of recoveredTxs) {
    if (tx.type === 'fill') {
      await state.recordFill(tx.tokenId, tx.side, tx.size, tx.price)
    }
  }

  return { state, txLog }
}
```

---

## 7. MONITORING & ALERTING

### Pino Logging + Metrics + Alert Channels

**Pino Setup (Fast, Structured):**

```typescript
import pino from 'pino'

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  },
})

// Contextual logging
const tradeLogger = log.child({ module: 'trade_execution' })
tradeLogger.info('order submitted', { orderId: 'x123', size: 100 })
```

**Metrics Collection:**

```typescript
import StatsD from 'node-statsd'

const metrics = new StatsD({
  host: process.env.STATSD_HOST || 'localhost',
  port: 8125,
})

// Track signal detection latency
const wsLatency = Date.now() - signalTime
metrics.histogram('ws.latency', wsLatency)

// Count fills
metrics.increment('order.filled')

// Gauge for active positions
const { positions } = state.getSnapshot()
metrics.gauge('positions.count', positions.length)
metrics.gauge('positions.notional', totalNotional)
```

**Alerting (Pagerduty / Slack):**

```typescript
class AlertManager {
  constructor(private slackWebhook: string) {}

  async alert(
    severity: 'critical' | 'warning' | 'info',
    title: string,
    details: Record<string, any>
  ) {
    if (severity !== 'critical' && Math.random() > 0.1) return // Sample warnings

    const payload = {
      text: `[${severity.toUpperCase()}] ${title}`,
      attachments: [
        {
          color:
            severity === 'critical'
              ? 'danger'
              : severity === 'warning'
                ? 'warning'
                : 'good',
          fields: Object.entries(details).map(([key, value]) => ({
            title: key,
            value: String(value),
            short: true,
          })),
        },
      ],
    }

    await fetch(this.slackWebhook, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }
}

// Monitor bot health
setInterval(async () => {
  if (Date.now() - lastFillTime > 300000) {
    // 5 minutes without a fill
    await alertManager.alert('warning', 'No fills detected', {
      lastFill: new Date(lastFillTime),
      since: `${Math.round((Date.now() - lastFillTime) / 1000)}s ago`,
    })
  }
}, 60000) // Check every minute
```

**Offline Detection:**

```typescript
class HealthMonitor {
  private lastSignal = Date.now()
  private lastFill = Date.now()

  recordSignal() {
    this.lastSignal = Date.now()
  }

  recordFill() {
    this.lastFill = Date.now()
  }

  getStatus(): 'healthy' | 'degraded' | 'offline' {
    const signalAge = Date.now() - this.lastSignal
    const fillAge = Date.now() - this.lastFill

    if (signalAge > 120000) return 'offline' // No signals in 2 minutes
    if (fillAge > 600000) return 'degraded' // No fills in 10 minutes
    return 'healthy'
  }
}
```

---

## 8. CONFIGURATION MANAGEMENT

### Typed Environment Variables + Per-Market Rules

```typescript
import { z } from 'zod'

const configSchema = z.object({
  // Bot identity
  BOT_NAME: z.string(),
  POLYMARKET_PRIVATE_KEY: z.string(),
  POLYMARKET_API_KEY: z.string(),

  // Global risk limits
  MAX_SESSION_NOTIONAL_USD: z.coerce.number().positive(),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().max(100),

  // Per-market rules (JSON string)
  MARKET_RULES: z.string().transform(s => JSON.parse(s)),

  // Target wallets to copy
  TARGET_WALLETS: z.string().transform(s => s.split(',')),

  // Copy ratio (0.1x to 1x)
  COPY_RATIO: z.coerce.number().min(0.1).max(1),

  // Infrastructure
  POLYMARKET_WS_URL: z.string().url(),
  RPC_ENDPOINTS: z.string().transform(s => s.split(',')),

  // Monitoring
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SLACK_WEBHOOK: z.string().optional(),
  STATSD_HOST: z.string().default('localhost'),
})

type Config = z.infer<typeof configSchema>

function loadConfig(): Config {
  const parsed = configSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('Config validation failed:', parsed.error)
    process.exit(1)
  }
  return parsed.data
}

// Per-market rules
interface MarketRule {
  marketId: string
  maxExposureUsd: number
  maxSizePerTrade: number
  enabled: boolean
}

const config = loadConfig()
const marketRules: Record<string, MarketRule> = config.MARKET_RULES
```

**.env.example:**

```env
BOT_NAME=polymarket-copy-bot-1

# Polymarket auth
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=sk_...

# Risk limits
MAX_SESSION_NOTIONAL_USD=10000
MAX_DRAWDOWN_PCT=15
MAX_PER_MARKET_NOTIONAL_USD=2000

# Market-specific rules (JSON)
MARKET_RULES='{"0x...market_1":{"maxExposureUsd":1000,"maxSizePerTrade":100,"enabled":true}}'

# Targets to copy
TARGET_WALLETS=0xABC,0xDEF,0xGHI
COPY_RATIO=0.5

# Infrastructure
POLYMARKET_WS_URL=wss://ws-api.polymarket.com
RPC_ENDPOINTS=https://rpc1.polymarket.com,https://rpc2.polymarket.com

# Monitoring
LOG_LEVEL=info
SLACK_WEBHOOK=https://hooks.slack.com/...
STATSD_HOST=localhost
```

---

## 9. TYPESCRIPT PROJECT STRUCTURE

### Monorepo Layout (Turborepo / pnpm Workspaces)

```
polymarket-copy-trading/
├── packages/
│   ├── core/                        # Shared domain logic
│   │   ├── src/
│   │   │   ├── types/               # Domain types (Trade, Order, Position)
│   │   │   ├── errors/              # Custom error classes
│   │   │   └── utils/               # Shared utilities (formatting, validation)
│   │   └── package.json
│   │
│   ├── bot/                          # Main bot process
│   │   ├── src/
│   │   │   ├── index.ts             # Entry point
│   │   │   ├── config.ts            # Config loading
│   │   │   ├── ws-client.ts         # WebSocket management
│   │   │   ├── rpc-router.ts        # RPC endpoint routing
│   │   │   ├── position-state.ts    # In-memory state
│   │   │   ├── risk-manager.ts      # Risk validation
│   │   │   ├── order-executor.ts    # Order submission
│   │   │   ├── trade-detector.ts    # Signal detection from targets
│   │   │   └── health-monitor.ts    # Bot health checks
│   │   └── package.json
│   │
│   ├── cli/                          # Command-line tools
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── start.ts         # Start bot
│   │   │   │   ├── status.ts        # Check bot status
│   │   │   │   ├── positions.ts     # Display positions
│   │   │   │   └── liquidate.ts     # Emergency liquidation
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── test/                         # Shared test utilities
│       ├── src/
│       │   ├── mocks/               # Mock exchange, RPC, WebSocket
│       │   ├── fixtures/            # Test data (trades, orders)
│       │   └── helpers.ts           # Test utilities
│       └── package.json
│
├── apps/
│   ├── bot-instance-1/              # Separate bot instance (different targets)
│   │   ├── .env                     # Instance config
│   │   └── package.json
│   │
│   └── bot-instance-2/
│       ├── .env
│       └── package.json
│
├── docs/
│   ├── architecture.md
│   ├── deployment.md
│   └── risk-management.md
│
├── tsconfig.json                     # Monorepo root config
├── turbo.json                        # Turborepo config
├── pnpm-workspace.yaml               # pnpm workspaces config
└── package.json                      # Root package.json
```

**tsconfig.json (Monorepo Root):**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "declaration": true,
    "outDir": "dist",
    "rootDir": "packages",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {
      "@polymarket/core": ["packages/core/src"],
      "@polymarket/test": ["packages/test/src"],
      "@polymarket/bot": ["packages/bot/src"]
    }
  }
}
```

**Compile & Run:**

```bash
# Install deps
pnpm install

# Build all packages
pnpm build

# Start bot (from apps/bot-instance-1)
pnpm -F bot-instance-1 start

# Run tests
pnpm test
```

---

## 10. INTEGRATION TESTING

### Test Strategy: Dual-Stack (Unit + Testnet)

**Unit Tests with Mocks:**

```typescript
// test/mocks/ws-mock.ts
export class MockWsClient extends PolymarketWsClient {
  async connect() {
    // Simulate connection immediately
    this.emit('open')
  }

  inject(trade: Trade) {
    // Simulate inbound market data
    this.emit('message', JSON.stringify(trade))
  }
}

// test/trade-executor.test.ts
describe('TradeExecutor', () => {
  let executor: TradeExecutor
  let mockWs: MockWsClient
  let state: PositionState

  beforeEach(() => {
    mockWs = new MockWsClient()
    state = new PositionState()
    executor = new TradeExecutor(mockWs, state)
  })

  it('should reject trades exceeding per-market cap', async () => {
    const trade = { market_id: 'usdc_usd', side: 'buy', size: 1000, price: 1.0 }
    state.positions.set('usdc_usd', { shares: 9500, notional: 9500 })

    const result = await executor.validateAndSubmit(trade, {
      maxPerMarketNotional: 10000,
    })

    expect(result).toBeNull() // Rejected
  })

  it('should submit valid trades within risk limits', async () => {
    const trade = { market_id: 'btc_usd', side: 'buy', size: 10, price: 45000 }
    const order = await executor.validateAndSubmit(trade, {
      maxPerMarketNotional: 1000000,
    })

    expect(order).toBeDefined()
    expect(order.size).toBe(10)
  })

  it('should prevent duplicate fills', async () => {
    const trade = { id: 'target_123', market_id: 'btc_usd', side: 'buy' }

    // First fill succeeds
    await executor.recordFill(trade)

    // Duplicate within 5s window should fail
    const isDupe = executor.isDuplicate(trade.id)
    expect(isDupe).toBe(true)
  })
})
```

**Testnet Integration Tests:**

```typescript
// test/integration.test.ts
describe('PolymartketCopyBot (Testnet)', () => {
  const testConfig = {
    POLYMARKET_PRIVATE_KEY: process.env.TEST_PRIVATE_KEY!,
    TARGET_WALLETS: ['0xTestWallet'],
    COPY_RATIO: 0.1,
    MAX_SESSION_NOTIONAL_USD: 100, // Small testnet amount
  }

  let bot: CopyTradingBot

  beforeAll(async () => {
    bot = new CopyTradingBot(testConfig)
    await bot.start()
  })

  afterAll(async () => {
    await bot.stop()
  })

  it('should detect a test trade on testnet', async () => {
    const fillPromise = new Promise<Order>(resolve => {
      bot.on('order:filled', resolve)
    })

    // Simulate test wallet trade via API
    await simulateTestTrade({
      wallet: '0xTestWallet',
      market: 'test_usdc',
      size: 100,
      side: 'buy',
    })

    const order = await Promise.race([
      fillPromise,
      sleep(30000).then(() => {
        throw new Error('timeout: no fill detected within 30s')
      }),
    ])

    expect(order.size).toBe(10) // COPY_RATIO of 0.1
  }, 40000) // 40s timeout
})
```

**Why Dual Stack:**

- **Unit tests**: Fast, isolated, catch logic bugs
- **Testnet tests**: Verify real Polymarket API integration, timing, edge cases

**Never Use:**
- Real Polymarket mainnet for testing
- Mocks that diverge from actual API behavior
- Dry-run mode that can't catch real API errors

---

## LIBRARY RECOMMENDATIONS

| Purpose | Library | Why | Adoption Risk |
|---------|---------|-----|---|
| **Logging** | `pino` | 10x faster than Winston; JSON-friendly | Low — mature, widely used |
| **WebSocket** | `ws` | No deps; RFC 6455 compliant; fast | Low — Node.js standard |
| **HTTP Client** | `node-fetch` or `undici` | Async/await native; keep-alive support | Low — fetch now built-in |
| **Config** | `zod` | Type-safe validation; great DX | Low — rapidly growing adoption |
| **Database** | SQLite (dev) + PostgreSQL (prod) | Durability without complexity; testnet friendly | Low — SQLite for dev only |
| **Metrics** | StatsD + Prometheus | Low overhead; easy alerting | Low — industry standard |
| **Testing** | Jest + `@testing-library` | Fast; great mocking support | Low — React/Node standard |
| **Concurrency** | `async-lock` | Prevent race conditions in state updates | Low — simple, well-tested |
| **Retry Logic** | `p-retry` | Exponential backoff; simple API | Low — single-purpose |

**Anti-Patterns:**
- ~~Bull/BullMQ~~: Overkill for single-bot task scheduling; use `node-cron` instead
- ~~TypeORM~~: Heavy for copy trading; use `kysely` (lightweight ORM)
- ~~RabbitMQ~~: Not needed for single bot; use in-memory queues
- ~~ML frameworks~~: Don't add until you have a clear strategy

---

## DEPLOYMENT ARCHITECTURE

### Minimal Production Setup

```
┌─────────────────────────────────────────────────┐
│ VPS (1CPU, 2GB RAM) or Docker container         │
├─────────────────────────────────────────────────┤
│ Node.js app (copy-trading-bot)                  │
│ ├── WebSocket: Polymarket live data             │
│ ├── RPC calls: Balance, position queries        │
│ └── HTTP: Order submission                      │
├─────────────────────────────────────────────────┤
│ SQLite (state durability)                       │
├─────────────────────────────────────────────────┤
│ Pino JSON logs → File or Datadog                │
├─────────────────────────────────────────────────┤
│ StatsD → Grafana dashboards                     │
└─────────────────────────────────────────────────┘
```

**Dockerfile:**

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

COPY packages ./packages
COPY apps/bot-instance ./

RUN pnpm build

EXPOSE 9000
CMD ["node", "dist/index.js"]
```

**Graceful Shutdown:**

```typescript
async function gracefulShutdown(signal: string) {
  log.info(`shutdown:${signal}`)

  // Phase 1: Stop accepting new signals
  wsClient.unsubscribeAll()

  // Phase 2: Liquidate open positions (optional)
  // await riskManager.liquidateAll()

  // Phase 3: Flush logs and metrics
  await log.flush()
  metrics.close()

  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
```

---

## ANTI-PATTERNS & GOTCHAS

| Anti-Pattern | Why It Fails | Fix |
|---|---|---|
| **Using threads for I/O** | Node.js single-threaded event loop handles async I/O natively; threads add memory + complexity | Stick with async/await |
| **Storing order data in memory only** | Bot crash = lost trades. No audit trail. | Write transaction log to SQLite |
| **Building ML arbitrage first** | Premature optimization. Copy trading is simpler. | Implement copy trading; add ML signals after proving concept |
| **Retry with no backoff** | Rate-limit all RPC calls; block bot | Exponential backoff (1s → 2s → 4s) |
| **Single WebSocket connection** | One blip = entire bot offline | Fallback to 2s HTTP polling |
| **Trusting untrusted market data** | Manipulation, oracle attacks | Validate via multiple RPC nodes |
| **No duplicate detection** | Same signal → multiple fills | Idempotency key (targetTradeId) + 5s window |
| **Logging everything to disk** | I/O bottleneck; fills miss latency window | Async JSON logs; sample warnings (10%) |

---

## UNRESOLVED QUESTIONS

1. **Polymarket testnet availability**: Is there a live testnet with realistic market conditions? Or must integration testing happen on mainnet with small orders?
2. **WebSocket message ordering**: Does Polymarket guarantee order of WebSocket messages? Needed to prevent race conditions in signal detection.
3. **RPC rate limits**: What are typical rate limits (requests/sec) for Polymarket RPC endpoints? Should we implement per-endpoint quotas?
4. **On-chain settlement latency**: How long does on-chain settlement take on Polygon? Could block order confirmation for 5–10 seconds.
5. **Position data freshness**: If position state rebuilds from transaction log, how do we detect liquidations or off-chain balance changes?
6. **Wallet key management**: Should private keys be stored in HSM / KMS or environment variables? (Security vs. operational complexity)
7. **Multi-instance coordination**: If running 2+ bot instances, how do they coordinate to avoid trading the same market simultaneously?

---

## RECOMMENDED IMPLEMENTATION ROADMAP

**Phase 1: Core Bot (Week 1–2)**
- [ ] Config loading + validation
- [ ] WebSocket client with reconnection
- [ ] RPC router with fallback
- [ ] Position state (in-memory)
- [ ] Risk validation
- [ ] Order executor
- [ ] Unit tests for risk logic

**Phase 2: Signal Detection (Week 2–3)**
- [ ] Target wallet discovery (REST API polling)
- [ ] Trade detection (WebSocket subscription)
- [ ] Duplicate prevention
- [ ] Health monitoring
- [ ] Integration tests on testnet

**Phase 3: Monitoring & Ops (Week 3–4)**
- [ ] Pino logging setup
- [ ] StatsD metrics
- [ ] Slack alerting
- [ ] Transaction log (SQLite)
- [ ] Graceful shutdown

**Phase 4: Hardening (Week 4+)**
- [ ] Circuit breaker for failed RPC endpoints
- [ ] Connection pooling tuning
- [ ] Emergency liquidation CLI
- [ ] Grafana dashboards
- [ ] Load testing (multiple markets)

---

## SUMMARY

**Best Architecture:** Async/await event-driven bot with persistent WebSocket + HTTP fallback, in-memory position cache backed by SQLite transaction log, strict risk management, and comprehensive observability.

**Key Wins:**
- 100–300ms signal-to-fill is realistic for Polymarket (not sub-50ms like CEX HFT)
- Async/await code is simpler and more maintainable than callbacks or worker threads
- Pino + StatsD is lightweight and proven for trading systems
- Risk management layer prevents most catastrophic failures

**Critical Success Factor:** Validate on Polymarket testnet **before** running mainnet. Use small orders (1–10% of session cap) for initial testing. Monitor latency distributions (p50, p95, p99) — if p95 > 500ms, fix infrastructure first before adding features.

---

**Sources:**

- [Crypto Trading Bots and Node Infrastructure: Ensuring Low Latency | Instanodes](https://medium.com/@instanodes3/crypto-trading-bots-and-node-infrastructure-ensuring-low-latency-f9d5351813fb)
- [Polymarket Copy Trading Bot | Quicknode Guides](https://www.quicknode.com/guides/defi/polymarket-copy-trading-bot)
- [How to Build a Polymarket Trading Bot | Medium](https://medium.com/@zegham.ali/how-to-build-a-polymarket-trading-bot-automation-copy-trading-arbitrage-00fc854e714a)
- [Engineering Solana Trading Bots: 2026 Infrastructure Guide | Dysnix](https://dysnix.com/blog/solana-trading-bot-guide)
- [Building Scalable WebSockets with Node.js | E Edge Technology](https://eedgetechnology.com/blog/building-scalable-websockets-with-node-js/)
- [Node.js: Building Scalable WebSockets | Empirical Edge](https://empiricaledge.com/blog/building-scalable-websockets-with-node-js/)
- [Optimizing RPC Endpoint Latency | TradingOnramp](https://tradingonramp.com/optimizing-rpc-endpoint-latency-for-high-performance-applications/)
- [Worker Threads in Node.js | Nodesource](https://nodesource.com/blog/worker-threads-nodejs-multithreading-in-javascript)
- [Polymarket-Betting-Bot GitHub](https://github.com/echandsome/Polymarket-betting-bot)
- [Polymarket Copy Trading Bot (Typescript) GitHub](https://github.com/leonyx007/Polymarket-Copy-Trading-Bot-Ts)
- [How to Build a Crypto Trading Bot with TypeScript & Bun | Luzia](https://luzia.dev/blog/how-to-build-a-crypto-trading-bot)
- [Pino vs Winston: Choosing the Right Logger | DEV Community](https://dev.to/wallacefreitas/pino-vs-winston-choosing-the-right-logger-for-your-nodejs-application-369n)
- [Mastering Monorepos: A Comprehensive Guide | Medium](https://medium.com/@yaroslavzhbankov/mastering-monorepos-a-comprehensive-guide-for-javascript-and-typescript-projects-7813614820b4)
- [Position Sizing in Trading: Strategies and Techniques | Quantinsti](https://blog.quantinsti.com/position-sizing/)
- [How to Test Your Crypto Trading Bot | Oxido Solutions](https://oxidosolutions.com/how-to-test-your-crypto-trading-bot/)
