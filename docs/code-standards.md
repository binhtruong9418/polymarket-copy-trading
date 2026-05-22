# Code Standards & Architecture Guidelines

## Overview

This document defines coding standards, naming conventions, architecture patterns, and testing requirements for the Polymarket Copy-Trading Bot codebase.

**Baseline:** TypeScript 5.8, strict mode, ESM, zero `any` types.

---

## File & Directory Naming

### File Naming
- **Format:** kebab-case for all `.ts` files (e.g., `trade-filter.ts`, `clob-client-singleton.ts`)
- **Exceptions:** None; all TypeScript files use kebab-case
- **Principle:** Self-documenting names for Grep/Glob tools; developers should understand purpose without opening file

### Examples
| Good | Bad | Reason |
|------|-----|--------|
| `trade-filter.ts` | `filter.ts` or `tradeFilter.ts` | Unambiguous purpose |
| `clob-client-singleton.ts` | `clobClient.ts` | Pattern + purpose clear |
| `position-store.ts` | `store.ts` or `positionStore.ts` | Module scope obvious |
| `market-enricher.ts` | `enricher.ts` | Specific domain (market) |

### Directory Naming
- **Format:** lowercase, no hyphens (e.g., `signal/`, `execution/`, `risk/`)
- **Principle:** Logical grouping by responsibility
- **Max depth:** 2 levels (src/module/file.ts)

---

## Naming Conventions

### TypeScript Interfaces & Types

**Naming Rule:** PascalCase, prefix with `I` for interfaces (optional but recommended for clarity).

```typescript
// ✓ Good
interface TradeSignal {
  id: string;
  sourceWallet: string;
  side: "BUY" | "SELL";
}

type CopyStrategy = "exact" | "proportional";

enum EventType {
  ORDER_SUBMITTED = "ORDER_SUBMITTED",
  ORDER_FILLED = "ORDER_FILLED",
  ORDER_FAILED = "ORDER_FAILED",
  POSITION_CLOSED = "POSITION_CLOSED",
}

// ✗ Bad (no `any`)
interface TradeSignal {
  payload: any; // Forbidden
}
```

### Classes

**Naming Rule:** PascalCase, verb+Noun or Noun (not `Manager`, prefer specific names).

```typescript
// ✓ Good
class PositionStore { ... }
class SignalEmitter extends EventEmitter { ... }
class RiskEngine { ... }
class TransactionLog { ... }

// ✗ Bad
class TradeManager { ... }         // Too vague
class signalEmitter { ... }        // Lowercase
class SignalEmitterManager { ... } // Redundant
```

### Functions & Methods

**Naming Rule:** camelCase, verb-first for actions, noun-first for getters.

```typescript
// ✓ Good (verbs)
function buildCopyOrder(signal: TradeSignal): OrderRequest { ... }
function refreshBalance(): Promise<number> { ... }
function parseTradeMessage(msg: any): TradeSignal { ... }

// ✓ Good (getters)
function getCachedBalance(): number { ... }
function getRuleForWallet(wallet: string): CopyRule | null { ... }

// ✗ Bad
function copyOrder(...) { ... }           // Unclear action
function balance() { ... }                // Noun-first for action
function get_cached_balance() { ... }     // snake_case
```

### Variables & Constants

**Naming Rule:**
- **Regular variables:** camelCase
- **Constants:** UPPER_SNAKE_CASE (only for truly immutable config)
- **Boolean variables:** prefix with `is`, `has`, `should` (e.g., `isConnected`, `hasBalance`)

```typescript
// ✓ Good
const MAX_RETRIES = 5;                    // Immutable config
const CIRCUIT_BREAKER_THRESHOLD = 60_000; // ms

const signalList: TradeSignal[] = [];
const isHealthy = wsClient.isConnected;
const hasBalance = balance > MIN_SIZE;

// ✗ Bad
const maxRetries = 5;                     // Should be UPPER_SNAKE_CASE
let isHealthy = true; let isHealthy2 = ... // Redundant booleans
const signal_list = []; // snake_case for var
```

### Private Members

**Naming Rule:** Prefix with `#` (TypeScript private field syntax) or `private` keyword with leading `_` only if forced.

```typescript
// ✓ Good (ES2022 private)
class PositionStore {
  #positions: Map<string, OpenPosition> = new Map();
  #initialized = false;

  getPosition(key: string): OpenPosition | null {
    return this.#positions.get(key);
  }
}

// ✓ Good (traditional private)
class RiskEngine {
  private positions: PositionStore;
  private guards: Guard[];
}

// ✗ Bad
class PositionStore {
  _positions: Map<...>;  // Looks public but meant private
  positions: Map<...>;   // Actually public; confusing
}
```

### Imports

**Naming Rule:** Named imports over default; use aliases for clarity.

```typescript
// ✓ Good
import { TradeSignal, CopyRule } from "../types/index.js";
import { SignalEmitter } from "./signal-emitter.js";
import type { OrderRequest } from "@polymarket/clob-client";

// ✓ Good (aliases)
import * as logger from "./utils/logger.js";
logger.info("Started");

// ✗ Bad
import signal from "../types"; // Default export ambiguous
import * as types from "../types"; types.TradeSignal; // Over-qualified
```

---

## Module Structure & Architecture Patterns

### Module Pattern: Singleton

For stateful services that should exist once per runtime (CLOB client, position store).

```typescript
// ✓ Good (singleton pattern)
let instance: ClobClient | null = null;

export function initClobClient(): void {
  instance = new ClobClient(env.POLYMARKET_API_KEY, ...);
}

export function getClobClient(): ClobClient {
  if (!instance) throw new Error("CLOB client not initialized");
  return instance;
}
```

### Module Pattern: Class-Based State

For modules managing mutable state (PositionStore, SessionTracker, TransactionLog).

```typescript
// ✓ Good
export class PositionStore {
  #positions: Map<string, OpenPosition> = new Map();

  addPosition(key: string, pos: OpenPosition): void {
    this.#positions.set(key, pos);
  }

  getPosition(key: string): OpenPosition | null {
    return this.#positions.get(key) ?? null;
  }
}
```

### Module Pattern: Pure Functions

For stateless operations (signal parsing, order building, guard evaluation).

```typescript
// ✓ Good
export function buildCopyOrder(
  signal: TradeSignal,
  rule: CopyRule,
): OrderRequest {
  // Pure: no side effects, same input → same output
  const size = rule.strategy === "exact" 
    ? signal.size 
    : signal.size * rule.ratio;
  
  return {
    conditionId: signal.conditionId,
    side: signal.side,
    size: Math.min(size, rule.maxPerTrade),
    price: signal.price,
  };
}
```

### Module Pattern: EventEmitter

For pub/sub signaling (signal detection, executor events).

```typescript
// ✓ Good
export class SignalEmitter extends EventEmitter {
  emitTrade(signal: TradeSignal): void {
    this.emit("trade", signal);
  }

  onTrade(callback: (signal: TradeSignal) => void): void {
    this.on("trade", callback);
  }
}

// Usage in bot-orchestrator.ts
signalEmitter.on("trade", async (signal) => {
  // Handle trade
});
```

### Dependency Injection

For testability, dependencies passed as constructor arguments or function params (avoid globals except logger).

```typescript
// ✓ Good (DI via constructor)
export class RiskEngine {
  constructor(
    private positions: PositionStore,
    private session: SessionTracker,
  ) {}

  async evaluate(signal: TradeSignal): Promise<RiskDecision> {
    // Use this.positions, this.session
  }
}

// ✓ Good (DI via function params)
export async function refreshBalance(client: ClobClient): Promise<number> {
  return client.getBalance();
}
```

---

## Error Handling

### Error Types

**Rule:** Use typed errors; never throw raw strings.

```typescript
// ✓ Good
throw new Error("CLOB client not initialized");
throw new Error(`Insufficient balance: have ${balance}, need ${required}`);

// ✗ Bad
throw "Client error"; // Not an Error object
throw "Something went wrong"; // Unstructured
```

### Async Error Handling

**Rule:** Always use try/catch for async functions; log and re-throw or handle.

```typescript
// ✓ Good
async function submitOrder(order: OrderRequest): Promise<OrderResponse> {
  try {
    const response = await clobClient.createAndPostOrder(order);
    logger.info({ orderId: response.id }, "Order submitted");
    return response;
  } catch (err) {
    logger.error({ err, order }, "Order submission failed");
    throw err; // Re-throw if critical, or handle gracefully
  }
}

// ✗ Bad
async function submitOrder(order: OrderRequest): Promise<OrderResponse> {
  const response = await clobClient.createAndPostOrder(order); // No error handling
  return response;
}
```

### Guard Clause Pattern

**Rule:** Return early for error cases; keep happy path unindented.

```typescript
// ✓ Good
export function validateSignal(signal: TradeSignal): boolean {
  if (!signal.id) return false;
  if (!signal.sourceWallet) return false;
  if (signal.price < 0 || signal.price > 1) return false;
  return true;
}

// ✗ Bad
export function validateSignal(signal: TradeSignal): boolean {
  if (signal.id && signal.sourceWallet && signal.price >= 0 && signal.price <= 1) {
    return true;
  } else {
    return false;
  }
}
```

---

## Type Safety

### No `any` Types

**Rule:** Forbidden. Always specify explicit types.

```typescript
// ✓ Good
function parseMessage(msg: Record<string, unknown>): TradeSignal | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  return {
    id: String(m.transactionHash ?? ""),
    side: String(m.side) as "BUY" | "SELL",
    // ... other fields with type guards
  };
}

// ✗ Bad
function parseMessage(msg: any): TradeSignal { // `any` forbidden
  return msg as TradeSignal; // Unsafe cast
}
```

### Type Predicates

**Rule:** Use type guards for narrowing; prefer named predicates.

```typescript
// ✓ Good
function isTradeSignal(obj: unknown): obj is TradeSignal {
  if (typeof obj !== "object" || obj === null) return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.sourceWallet === "string" &&
    (s.side === "BUY" || s.side === "SELL")
  );
}

if (isTradeSignal(message)) {
  // message is TradeSignal here
  console.log(message.id);
}
```

### Const Assertions

**Rule:** Use `as const` for readonly tuples and literal types.

```typescript
// ✓ Good
const EVENT_TYPES = ["ORDER_SUBMITTED", "ORDER_FILLED", "ORDER_FAILED"] as const;
type EventType = typeof EVENT_TYPES[number]; // "ORDER_SUBMITTED" | ...

const GUARDS = ["sell", "staleness", "balance", "exposure"] as const;
const guardMap = new Map(GUARDS.map(g => [g, createGuard(g)]));
```

---

## Async/Await & Promises

### Rule: Prefer async/await over .then()

```typescript
// ✓ Good
export async function runBotLifecycle(): Promise<void> {
  await initClobClient();
  await refreshBalance();
  await startSignalEmitter();
  await waitForShutdown();
}

// ✗ Bad (callback hell)
export function runBotLifecycle(): Promise<void> {
  return initClobClient()
    .then(() => refreshBalance())
    .then(() => startSignalEmitter())
    .then(() => waitForShutdown());
}
```

### Rule: Handle Promise rejections

```typescript
// ✓ Good
async function main(): Promise<void> {
  try {
    await bot.start();
  } catch (err) {
    logger.fatal({ err }, "Bot startup failed");
    process.exit(1);
  }
}

// ✗ Bad
bot.start().catch(console.error); // Untyped, not logged
```

---

## Comments & Documentation

### Inline Comments

**Rule:** Explain *why*, not *what*. Code should be self-documenting.

```typescript
// ✓ Good
// Drawdown persists 24h to prevent rapid re-entry after recovery
const drawdownHaltMs = 24 * 60 * 60 * 1000;

// ✓ Good
// Reject BUY orders if no opposing SELL position exists (market-making safety)
if (signal.side === "BUY" && !this.positions.has(conditionId)) {
  return { approved: false, reason: "No opposing SELL position" };
}

// ✗ Bad (explains the obvious)
const drawdownHaltMs = 86_400_000; // 24 hours in milliseconds
if (signal.side === "BUY") { // Check if BUY
  // ...
}
```

### Function Documentation (JSDoc)

**Rule:** Document public functions with JSDoc if behavior is non-obvious.

```typescript
// ✓ Good
/**
 * Builds a copy order from a trade signal and copy rule.
 * 
 * Applies strategy (exact or proportional) and caps size to max per trade.
 * Ensures minimum $1 USDC order size.
 * 
 * @param signal - Detected trade signal from target wallet
 * @param rule - Copy rules (strategy, ratio, caps)
 * @returns CLOB OrderRequest ready for submission
 * @throws Error if validation fails
 */
export function buildCopyOrder(
  signal: TradeSignal,
  rule: CopyRule,
): OrderRequest {
  // ...
}

// ✗ Bad (missing docs for public function)
export function buildCopyOrder(signal: TradeSignal, rule: CopyRule): OrderRequest {
  // ...
}
```

---

## File Size & Modularization

### Rule: Keep files ≤200 LOC

**Target:** 50–150 LOC per file (optimal for review and testing).

**When to split:**
- File >200 LOC → extract related functions into separate module
- Class >150 LOC → check for violation of Single Responsibility Principle
- Function >50 LOC → consider breaking into smaller steps

### Example: Splitting

```typescript
// ❌ Bad: 250 LOC in one file
// risk-engine.ts (too large)

// ✓ Good: Split by concern
// risk-engine.ts (68 LOC)
export class RiskEngine {
  evaluate(signal: TradeSignal): RiskDecision { ... }
}

// balance-guard.ts (54 LOC)
export function refreshBalance(): Promise<number> { ... }

// exposure-guard.ts (38 LOC)
export function checkExposure(...): RiskDecision { ... }

// drawdown-guard.ts (38 LOC)
export function checkDrawdown(...): RiskDecision { ... }
```

---

## Testing Standards

### Test Organization

```
tests/
├── unit/
│   ├── signal/
│   │   ├── trade-filter.test.ts
│   │   └── signal-emitter.test.ts
│   ├── execution/
│   │   ├── order-builder.test.ts
│   │   └── dedup-cache.test.ts
│   └── ...
└── integration/
    └── bot-orchestrator.test.ts
```

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { buildCopyOrder } from "../../../src/execution/order-builder.js";

describe("order-builder", () => {
  describe("buildCopyOrder", () => {
    it("applies exact strategy when requested", () => {
      const signal: TradeSignal = { /* ... */ };
      const rule: CopyRule = {
        strategy: "exact",
        ratio: 1,
        maxPerTrade: 100,
        // ...
      };

      const order = buildCopyOrder(signal, rule);

      expect(order.size).toBe(signal.size);
    });

    it("caps size to maxPerTrade", () => {
      const signal: TradeSignal = { size: 500, /* ... */ };
      const rule: CopyRule = { maxPerTrade: 50, /* ... */ };

      const order = buildCopyOrder(signal, rule);

      expect(order.size).toBe(50);
    });

    it("throws if size < $1", () => {
      const signal: TradeSignal = { size: 0.5, /* ... */ };
      const rule: CopyRule = { /* ... */ };

      expect(() => buildCopyOrder(signal, rule)).toThrow();
    });
  });
});
```

### Coverage Target

- **Line coverage:** >70%
- **Branch coverage:** >60%
- **Skip:** Heavy mocking of external APIs; focus on business logic

### Test Naming

**Rule:** Describe behavior, not implementation. Start with "should" or "when".

```typescript
// ✓ Good
it("should reject BUY if no opposing SELL position", () => { ... });
it("should cap size to maxPerTrade", () => { ... });
it("when signal is stale (>10s), should reject", () => { ... });

// ✗ Bad
it("tests exact strategy", () => { ... });
it("BUY case", () => { ... });
it("checkExposure logic", () => { ... });
```

---

## Git Commit Standards

### Commit Message Format

**Rule:** Conventional Commits (type(scope): message).

```
feat(signal): add Gamma API fallback for market enrichment
fix(risk): prevent double-rejection in balance guard
refactor(execution): simplify order-builder logic
test(state): add recovery tests for orphaned orders
docs: update architecture diagrams
chore: upgrade typescript to 5.8
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code reorganization (no behavior change) |
| `test` | Add/update tests |
| `docs` | Documentation only |
| `chore` | Dependencies, tooling |
| `perf` | Performance improvement |

### Scope (Optional)

- `signal`, `execution`, `risk`, `state`, `monitoring`, `config`, `types`
- Only if change affects specific module

### Message Body (Optional)

Include context for why the change was made:

```
feat(risk): add drawdown halt persistence

Drawdown is now stored in SQLite to persist across restarts.
A 24h halt applies even after bot restart, preventing rapid re-entry
after recovery.

Fixes #45
```

### Rules

- **No AI references** in commits (no "Claude", "GPT", etc.)
- **Focused commits** (one logical change per commit)
- **Tested** before committing (no broken tests)
- **No secrets** (never commit .env, keys, credentials)

---

## Linting & Formatting

### Biome Configuration

**File:** `biome.json`

```json
{
  "linter": {
    "enabled": true,
    "rules": {
      "correctness": { "noUndeclaredVariables": "error" },
      "style": { "noImplicitAnyType": "error" }
    }
  },
  "formatter": { "enabled": true }
}
```

### Pre-commit

```bash
npm run lint    # Enforce style
npm run test    # Run tests
npm run build   # Check TypeScript
```

### No Auto-fixes

**Rule:** Lint errors must be manually fixed; no auto-fix commits.

---

## Performance Considerations

### Latency-Critical Paths

- **Signal detection → order submission:** Target <1s (network-dependent)
- **SQLite writes:** <1ms (WAL mode, synchronous)
- **Balance refresh:** Cache 5min (not per-trade)

### Memory Efficiency

- **Dedup cache:** LRU 500 entries, 5min TTL
- **Position store:** In-memory only (recoverable from SQLite)
- **Event log:** Indefinite (size managed by user)

### Avoid

- Heavy iteration in hot loops (use Sets/Maps, not arrays)
- Synchronous I/O (always async)
- Unbounded caches (use LRU with expiry)

---

## Security Practices

### Secrets Management

- **Never log** private keys, API keys, wallet addresses
- **Use env vars** for credentials (never hardcoded)
- **Validate env** at startup (Zod schema)
- **Redact** in error messages (use `***` for sensitive fields)

```typescript
// ✓ Good
logger.info({ apiKey: "***" }, "CLOB client initialized");

// ✗ Bad
logger.debug({ apiKey: env.POLYMARKET_API_KEY }, "Using key"); // Exposes secret
```

### Input Validation

- **Validate all external input** (WS messages, HTTP responses)
- **Use Zod** for config; custom validators for trade signals
- **Type guards** for runtime type checking

---

## Code Review Checklist

Before submitting a PR:

- [ ] TypeScript strict mode, no `any`
- [ ] All functions/classes have JSDoc (if public)
- [ ] File <200 LOC
- [ ] Tests written and passing (>70% coverage)
- [ ] No hardcoded secrets or credentials
- [ ] Commit messages follow convention
- [ ] No breaking changes (or clearly documented)
- [ ] Lint passes (`npm run lint`)
- [ ] Types check (`npm run typecheck`)

---

## Glossary

| Term | Definition |
|------|-----------|
| DI | Dependency Injection (pass deps as params) |
| JSDoc | JavaScript documentation format |
| PascalCase | CapitalizedWords (e.g., `TradeSignal`) |
| camelCase | lowerCamelCase (e.g., `buildCopyOrder`) |
| UPPER_SNAKE_CASE | CONSTANT_VALUE (e.g., `MAX_RETRIES`) |
| EOL | End of Line |
| WAL | Write-Ahead Logging (SQLite mode) |
