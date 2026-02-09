const { getCommonConfig } = require('../../shared/config/env');
const { DatabaseEventStore } = require('../../shared/idempotency/eventStore');
const { startConsumerService } = require('../../shared/rabbitmq/consumerService');

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shouldFail(failureRate) {
  return Math.random() < failureRate;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWorker(logger) {
  const common = getCommonConfig('payment-service');

  const queueNames = {
    main: process.env.PAYMENT_QUEUE || 'payment_queue',
    retry: process.env.PAYMENT_RETRY_QUEUE || 'payment_retry_queue',
    dlq: process.env.PAYMENT_DLQ || 'payment_dlq'
  };

  const failureRate = Math.max(0, Math.min(1, Number(process.env.PAYMENT_FAILURE_RATE || 0.5)));
  const processingMs = parseNumber(process.env.PAYMENT_PROCESSING_MS, 600);
  const eventStore = new DatabaseEventStore(common.serviceName);

  logger.info('Payment worker configuration loaded', {
    queueNames,
    failureRate,
    processingMs
  });

  return startConsumerService({
    serviceName: common.serviceName,
    logger,
    rabbitmqUrl: common.rabbitmqUrl,
    exchangeName: common.orderExchange,
    queueNames,
    retryDelayMs: common.retryDelayMs,
    prefetchCount: common.prefetchCount,
    maxRetries: common.maxRetries,
    eventStore,
    processEvent: async (event) => {
      logger.info('Processing payment', {
        eventId: event.eventId,
        orderId: event.orderId,
        amount: event.payload.amount,
        currency: event.payload.currency
      });

      await sleep(processingMs);

      if (shouldFail(failureRate)) {
        throw new Error('Simulated payment gateway failure');
      }

      logger.info('Payment processed', {
        eventId: event.eventId,
        orderId: event.orderId
      });
    }
  });
}

module.exports = {
  startWorker
};
