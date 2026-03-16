// order-service/src/timeoutChecker.ts
import { SagaStateManager } from "../../shared/saga/sagaState";
import { SagaHandler } from "./sagaHandler";
import { pool } from "../config/db";
import { parseNumber } from "../../shared/utils/parseNumber";
import type { Logger } from "../../shared/utils/logger";

const CHECK_INTERVAL_MS = parseNumber(process.env.TIMEOUT_CHECK_INTERVAL_MS, 10000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startTimeoutChecker(logger: Logger): Promise<void> {
  logger.info("Starting Order Service timeout checker", {
    checkIntervalMs: CHECK_INTERVAL_MS,
  });

  const sagaManager = new SagaStateManager(pool);
  const sagaHandler = new SagaHandler(pool, sagaManager, logger);

  const shutdown = async () => {
    logger.warn("Order service timeout checker shutdown requested");
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (true) {
    try {
      const timedOutSagas = await sagaManager.findPendingTimeouts();

      if (timedOutSagas.length > 0) {
        logger.info(`Found ${timedOutSagas.length} timed out saga(s)`, {
          sagaIds: timedOutSagas.map((s) => s.saga_id),
        });

        for (const saga of timedOutSagas) {
          try {
            await sagaHandler.handleTimeout(saga);
          } catch (error) {
            const err = error as Error;
            logger.error("Failed to handle saga timeout", {
              sagaId: saga.saga_id,
              error: err.message,
            });
          }
        }
      }
    } catch (error) {
      const err = error as Error;
      logger.error("Timeout checker loop failed", { error: err.message });
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}
