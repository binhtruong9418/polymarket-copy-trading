# Phase 1: Project Scaffolding & Configuration

**Status:** pending | **Priority:** critical

## Context Links
- [Polymarket Technical Research](../reports/researcher-260522-1106-polymarket-technical-research.md)
- [Low-Latency Architecture Research](../reports/researcher-260522-1106-ultra-low-latency-copy-trading-architecture.md)

## Overview

Set up a production-grade TypeScript Node.js project with proper tooling, type-safe config, and directory structure optimized for low-latency trading.

## Architecture

```
polymarket-copy-trading/
├── src/
│   ├── config/
│   │   ├── env-config.ts           # Zod-validated env vars
│   │   └── trading-config.ts       # Per-trader copy rules
│   ├── types/
│   │   └── index.ts                # Shared types (Order, Trade, Position)
│   ├── utils/
│   │   └── logger.ts               # Pino logger singleton
│   └── index.ts                    # Entry point
├── .env.example
├── package.json
├── tsconfig.json
└── biome.json                      # Linting/formatting (faster than ESLint)
```

## Implementation Steps

1. **Initialize project**
   ```bash
   mkdir polymarket-copy-trading && cd polymarket-copy-trading
   npm init -y
   npm install typescript ts-node @types/node --save-dev
   npm install @polymarket/clob-client @polymarket/real-time-data-client
   npm install ethers pino zod better-sqlite3
   npm install @types/better-sqlite3 --save-dev
   npm install --save-dev @biomejs/biome
   ```

2. **tsconfig.json** — strict mode, ES2022, NodeNext module resolution
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "strict": true,
       "outDir": "dist",
       "rootDir": "src",
       "resolveJsonModule": true
     }
   }
   ```

3. **Zod config schema** (`src/config/env-config.ts`)
   - `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYMARKET_PASSPHRASE`
   - `PRIVATE_KEY` — bot's own Polygon wallet
   - `RPC_URL` — QuickNode/Uniblock Polygon endpoint
   - `TARGET_WALLETS` — comma-separated addresses to copy
   - `COPY_RATIO` — default position size ratio (0.1–1.0)
   - `MAX_NOTIONAL_PER_TRADE` — USD cap per single trade
   - `MAX_SESSION_NOTIONAL` — total session exposure cap

4. **Trading config** (`src/config/trading-config.ts`)
   - Per-wallet override: `{ wallet, ratio, maxPerTrade, markets: string[] }`
   - Load from env + optional JSON config file

5. **Pino logger** (`src/utils/logger.ts`)
   - Structured JSON output, `level: process.env.LOG_LEVEL || 'info'`
   - Child loggers per component (signal, execution, risk)

6. **package.json scripts**
   ```json
   {
     "start": "node dist/index.js",
     "dev": "ts-node --esm src/index.ts",
     "build": "tsc",
     "lint": "biome check src/",
     "typecheck": "tsc --noEmit"
   }
   ```

7. **`.env.example`** — template with all required vars (no real values)

## Files to Create

- `src/index.ts`
- `src/config/env-config.ts`
- `src/config/trading-config.ts`
- `src/types/index.ts`
- `src/utils/logger.ts`
- `package.json`, `tsconfig.json`, `biome.json`, `.env.example`, `.gitignore`

## Todo

- [ ] Init npm project + install all dependencies
- [ ] Configure TypeScript (strict, NodeNext)
- [ ] Implement Zod env validation with clear error messages
- [ ] Create shared types (Trade, Order, Position, CopyRule)
- [ ] Set up Pino logger singleton
- [ ] Add `.gitignore` (node_modules, .env, dist)
- [ ] Verify `npm run typecheck` passes

## Success Criteria
- `npm run dev` starts without errors
- Missing env vars throw descriptive Zod errors
- All types compile cleanly

## Security Considerations
- Private key only in `.env`, never committed
- `.env` in `.gitignore`
- No secrets in logs (pino redact config)
