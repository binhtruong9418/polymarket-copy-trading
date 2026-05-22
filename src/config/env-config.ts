import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  // Optional in dry-run mode; required for live trading (validated at startup)
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_SECRET: z.string().optional(),
  POLYMARKET_PASSPHRASE: z.string().optional(),
  PRIVATE_KEY: z.string().optional(),
  FUNDER_ADDRESS: z.string().optional(),

  TARGET_WALLETS: z
    .string()
    .min(1, "TARGET_WALLETS is required")
    .transform((v) =>
      v
        .split(",")
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean),
    ),
  COPY_STRATEGY: z.enum(["exact", "proportional"]).default("proportional"),
  COPY_RATIO: z.coerce.number().min(0.01).max(1).default(0.1),
  MAX_NOTIONAL_PER_TRADE: z.coerce.number().positive().default(50),
  MAX_MARKET_EXPOSURE: z.coerce.number().positive().default(500),
  MAX_SESSION_NOTIONAL: z.coerce.number().positive().default(2000),
  MAX_DRAWDOWN_PCT: z.coerce.number().min(1).max(100).default(15),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment config:\n${issues}`);
  }
  return result.data;
}

export const env = loadEnv();

// Called at startup when DRY_RUN=false — ensures live trading creds are present
export function assertLiveTradingCreds(): void {
  const missing: string[] = [];
  if (!env.POLYMARKET_API_KEY)   missing.push("POLYMARKET_API_KEY");
  if (!env.POLYMARKET_SECRET)    missing.push("POLYMARKET_SECRET");
  if (!env.POLYMARKET_PASSPHRASE) missing.push("POLYMARKET_PASSPHRASE");
  if (!env.PRIVATE_KEY)          missing.push("PRIVATE_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Live trading requires these env vars (or set DRY_RUN=true):\n  ${missing.join("\n  ")}`,
    );
  }
}
