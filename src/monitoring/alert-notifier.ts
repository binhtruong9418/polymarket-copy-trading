import { env } from "../config/env-config.js";
import logger from "../utils/logger.js";
import type { TradeSignal, CopyRule } from "../types/index.js";
import type { BuiltOrder } from "../execution/order-builder.js";

type Severity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

// Rate-limit: same severity+tag at most once per 5 minutes
const lastSentAt = new Map<string, number>();
const RATE_LIMIT_MS = 5 * 60 * 1000;

export async function sendAlert(
  severity: Severity,
  tag: string,
  message: string,
): Promise<void> {
  const key = `${severity}:${tag}`;
  const last = lastSentAt.get(key) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return;

  lastSentAt.set(key, Date.now());
  const text = `[${severity}] [${tag}] ${message} — ${new Date().toISOString()}`;
  logger.info({ severity, tag, message }, "Alert fired");

  await Promise.all([
    sendSlack(text),
    sendTelegram(text),
  ]);
}

// Send Telegram message. No rate-limiting — callers control frequency.
export async function sendTelegram(text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    logger.warn({ err }, "Telegram notification delivery failed");
  }
}

// Notify Telegram about a dry-run copy trade with full trade details.
export async function notifyDryRunTrade(
  signal: TradeSignal,
  order: BuiltOrder,
  rule: CopyRule,
): Promise<void> {
  const sideEmoji = signal.side === "BUY" ? "🟢" : "🔴";
  const outcomeEmoji = signal.outcome === "Up" ? "📈" : signal.outcome === "Down" ? "📉" : "🎯";
  const lag = signal.detectedAt - signal.timestamp;
  const lines = [
    `<b>🔍 DRY-RUN Copy Trade Signal</b>`,
    ``,
  ];
  if (signal.title) lines.push(`📌 <b>${signal.title}</b>`);
  if (signal.outcome) lines.push(`${outcomeEmoji} Outcome: <b>${signal.outcome}</b>`);
  lines.push(
    ``,
    `${sideEmoji} <b>${signal.side}</b>  |  Price: <b>${(signal.price * 100).toFixed(2)}¢</b>  |  Implied: ${(signal.price * 100).toFixed(0)}%`,
    `Copy size: <b>$${order.userOrder.size} USDC</b>  (original: $${signal.size})`,
    `Strategy: ${rule.strategy} × ${rule.ratio}`,
    ``,
    `Source wallet: <code>${signal.sourceWallet}</code>`,
    `Signal lag: ${lag}ms  |  ${new Date(signal.timestamp).toISOString()}`,
  );
  const text = lines.join("\n");

  logger.info({ signal, copySize: order.userOrder.size }, "DRY_RUN — notifying Telegram");
  await sendTelegram(text);
}

async function sendSlack(text: string): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    logger.warn({ err }, "Slack alert delivery failed");
  }
}
