import "dotenv/config";
import { env, assertLiveTradingCreds } from "./config/env-config.js";
import logger from "./utils/logger.js";

if (env.DRY_RUN) {
  logger.info("Mode: DRY_RUN — no orders will be placed");
  const { startDryRunRunner } = await import("./runners/dry-run-runner.js");
  await startDryRunRunner();
} else {
  logger.info("Mode: LIVE — orders will be placed on Polymarket");
  assertLiveTradingCreds();
  const { BotOrchestrator } = await import("./monitoring/bot-orchestrator.js");
  const bot = new BotOrchestrator();
  await bot.start().catch((err) => {
    logger.fatal({ err }, "Bot failed to start");
    process.exit(1);
  });
}
