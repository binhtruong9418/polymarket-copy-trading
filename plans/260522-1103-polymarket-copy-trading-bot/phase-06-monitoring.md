# Phase 6: Monitoring & Alerting

**Status:** pending | **Priority:** medium

## Overview

Structured logging, latency metrics, health checks, and Slack/Telegram alerts for critical events (halt, downtime, large losses).

## Architecture

```
src/monitoring/
├── metrics-tracker.ts      # In-memory latency histograms + counters
├── health-checker.ts       # Periodic liveness check (WS alive, API reachable)
├── alert-notifier.ts       # Slack/Telegram webhook sender
└── bot-orchestrator.ts     # Top-level wiring: signal → risk → execute → log
```

## Metrics to Track

| Metric | Type | Description |
|--------|------|-------------|
| `signal_to_order_ms` | Histogram | Full latency: WS receipt → order submitted |
| `orders_submitted_total` | Counter | All order attempts |
| `orders_filled_total` | Counter | Confirmed fills |
| `orders_failed_total` | Counter | API errors + rejections |
| `risk_rejections_total` | Counter | Orders blocked by risk engine |
| `ws_reconnects_total` | Counter | WebSocket reconnection count |
| `session_pnl_usd` | Gauge | Running P&L in USDC |

## Alert Triggers

| Event | Severity | Channel |
|-------|----------|---------|
| WS disconnected > 30s | WARNING | Slack |
| Drawdown halt triggered | CRITICAL | Slack + Telegram |
| Circuit breaker open | ERROR | Slack |
| No signals in 10min (market hours) | WARNING | Slack |
| Bot process crash | CRITICAL | Slack (via process signal) |
| Session P&L < -$200 | WARNING | Slack |

## Implementation Steps

1. **Metrics tracker** (`src/monitoring/metrics-tracker.ts`)
   - Simple in-memory rolling stats (no external StatsD dependency — YAGNI)
   - P99/P50 latency for `signal_to_order_ms` using a 1000-sample ring buffer
   - Print summary every 5 minutes to stdout (pino INFO)
   - Expose `recordLatency(ms)`, `increment(counter)`, `getSummary()`

2. **Health checker** (`src/monitoring/health-checker.ts`)
   - Run every 60s: ping Polymarket REST API + check WS last-message age
   - If WS last message > 2min: trigger reconnect + WARNING alert
   - If REST API unreachable: ERROR alert + pause execution
   - Expose `isHealthy(): boolean` for graceful shutdown logic

3. **Alert notifier** (`src/monitoring/alert-notifier.ts`)
   - Slack webhook via simple `fetch` POST (no SDK needed)
   - Telegram bot API as secondary (optional, config-gated)
   - Rate-limit alerts: same alert type max once per 5min (prevent spam)
   - Format: `[SEVERITY] [component] message — timestamp`

4. **Bot orchestrator** (`src/monitoring/bot-orchestrator.ts`)
   - Top-level class that wires all components together
   - `start()`: init CLOB client → recover state → connect WS → start health checks
   - `stop()`: graceful shutdown (cancel pending orders, flush logs, close DB)
   - Handle `SIGTERM`/`SIGINT` for clean shutdown
   - On signal received: `riskEngine.evaluate()` → `orderExecutor.submit()` → `metricsTracker.record()`

## Files to Create

- `src/monitoring/metrics-tracker.ts`
- `src/monitoring/health-checker.ts`
- `src/monitoring/alert-notifier.ts`
- `src/monitoring/bot-orchestrator.ts`

## Todo

- [ ] Implement ring-buffer latency tracker (P50/P99)
- [ ] Implement health checker with WS liveness + REST ping
- [ ] Implement Slack webhook alerter with 5min rate limiting
- [ ] Implement bot orchestrator (start/stop lifecycle)
- [ ] Wire `SIGTERM`/`SIGINT` → graceful shutdown
- [ ] Add 5-minute metrics summary log
- [ ] Test: verify alert fires on simulated WS disconnect

## Success Criteria
- Latency metrics logged every 5 minutes
- Slack alert received within 60s of drawdown halt
- Graceful shutdown cancels open orders before exit
- Health checker detects WS stall and triggers reconnect
