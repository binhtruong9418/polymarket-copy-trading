import { ClobClient, Chain } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { env } from "../config/env-config.js";
import logger from "../utils/logger.js";

const CLOB_HOST = "https://clob.polymarket.com";

let instance: ClobClient | null = null;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

const CIRCUIT_BREAK_THRESHOLD = 5;
const CIRCUIT_BREAK_MS = 60_000;

export function getClobClient(): ClobClient {
  if (!instance) {
    throw new Error("ClobClient not initialized — call initClobClient() first");
  }
  return instance;
}

export async function initClobClient(): Promise<ClobClient> {
  // assertLiveTradingCreds() is guaranteed to have run before this — creds are non-null
  const signer = new Wallet(env.PRIVATE_KEY!);

  // ethers v5 Wallet satisfies ClobClient's EthersSigner interface
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance = new ClobClient(
    CLOB_HOST,
    Chain.POLYGON,
    signer as any,
    {
      key: env.POLYMARKET_API_KEY!,
      secret: env.POLYMARKET_SECRET!,
      passphrase: env.POLYMARKET_PASSPHRASE!,
    },
    0, // signatureType 0 = EOA private key
    env.FUNDER_ADDRESS,
  );

  logger.info({ address: await signer.getAddress() }, "ClobClient initialized");
  return instance;
}

export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export function recordSuccess(): void {
  consecutiveFailures = 0;
}

export function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_BREAK_MS;
    logger.error(
      { openUntil: new Date(circuitOpenUntil).toISOString() },
      "Circuit breaker opened — pausing order submission for 60s",
    );
    consecutiveFailures = 0;
  }
}
