const { getCommonConfig } = require('../../shared/config/env');
const { DatabaseEventStore } = require('../../shared/idempotency/eventStore');
const { startConsumerService } = require('../../shared/rabbitmq/consumerService');

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWorker(logger) {
  const common = getCommonConfig('notification-service');

  const queueNames = {
    main: process.env.NOTIFICATION_QUEUE || 'notification_queue',
    retry: process.env.NOTIFICATION_RETRY_QUEUE || 'notification_retry_queue',
    dlq: process.env.NOTIFICATION_DLQ || 'notification_dlq'
  };

  const processingMs = parseNumber(process.env.NOTIFICATION_PROCESSING_MS, 250);
  const eventStore = new DatabaseEventStore(common.serviceName);

  logger.info('Notification worker configuration loaded', {
    queueNames,
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
      logger.info('Sending notification', {
        eventId: event.eventId,
        orderId: event.orderId,
        customerEmail: event.payload.customerEmail
      });

      await sleep(processingMs);

      logger.info('Notification sent', {
        eventId: event.eventId,
        orderId: event.orderId
      });
    }
  });
}

module.exports = {
  startWorker
};
