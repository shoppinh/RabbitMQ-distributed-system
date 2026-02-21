// Timeout Checker for Order Service
// Checks for sagas that have exceeded the timeout and cancels them

const { SagaStatus } = require("../../shared/saga/sagaState");
const { SagaStateManager } = require("../../shared/saga/sagaState");
const { SagaHandler } = require("./sagaHandler");
const { pool } = require("../config/db");
const { parseNumber } = require("../../shared/utils/parseNumber");

const CHECK_INTERVAL_MS = parseNumber(process.env.TIMEOUT_CHECK_INTERVAL_MS, 10000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTimeoutChecker(logger) {
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
      // Find all pending sagas that have timed out
      const timedOutSagas = await sagaManager.findPendingTimeouts();

      if (timedOutSagas.length > 0) {
        logger.info(`Found ${timedOutSagas.length} timed out saga(s)`, {
          sagaIds: timedOutSagas.map((s) => s.saga_id),
        });

        for (const saga of timedOutSagas) {
          try {
            await sagaHandler.handleTimeout(saga);
          } catch (error) {
            logger.error("Failed to handle saga timeout", {
              sagaId: saga.saga_id,
              error: error.message,
            });
          }
        }
      }
    } catch (error) {
      logger.error("Timeout checker loop failed", {
        error: error.message,
      });
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

module.exports = {
  startTimeoutChecker,
};
