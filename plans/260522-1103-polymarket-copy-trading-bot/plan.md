---
name: polymarket-copy-trading-bot
status: completed
created: 2026-05-22
priority: high
blockedBy: []
blocks: []
---

# Polymarket Copy Trading Bot

Ultra-low-latency bot that detects trades from 1-5 target wallets on Polymarket (Polygon) and mirrors them in real-time using TypeScript/Node.js.

## Overview

- **Target latency:** <300ms from signal detection to order submitted
- **Network:** Polygon (MATIC)
- **Language:** TypeScript / Node.js
- **Copy strategy:** Exact mirror + proportional sizing (configurable per trader)
- **Scale:** 1-5 target traders

## Phases

| # | Phase | Status | Priority |
|---|-------|--------|----------|
| 1 | [Project Scaffolding & Config](phase-01-scaffolding.md) | ✅ complete | critical |
| 2 | [Signal Detection Engine](phase-02-signal-detection.md) | ✅ complete | critical |
| 3 | [Order Execution Engine](phase-03-order-execution.md) | ✅ complete | critical |
| 4 | [Risk Management Layer](phase-04-risk-management.md) | ✅ complete | high |
| 5 | [State Management & Persistence](phase-05-state-management.md) | ✅ complete | high |
| 6 | [Monitoring & Alerting](phase-06-monitoring.md) | ✅ complete | medium |
| 7 | [Testing & Validation](phase-07-testing.md) | ✅ complete | high |

## Key Dependencies

- `@polymarket/clob-client-v2` — order placement, gasless EIP-712 signatures
- `@polymarket/real-time-data-client` — WebSocket trade feed
- `ethers` v6 — Polygon wallet/signing
- `pino` — structured logging (10x faster than Winston)
- `zod` — runtime config validation
- SQLite (better-sqlite3) — transaction log durability

## Research Reports

- [Polymarket Technical Research](../reports/researcher-260522-1106-polymarket-technical-research.md)
- [Low-Latency Architecture Research](../reports/researcher-260522-1106-ultra-low-latency-copy-trading-architecture.md)
