const { getCommonConfig } = require('../../shared/config/env');
const { InMemoryEventStore } = require('../../shared/idempotency/eventStore');
const { startConsumerService } = require('../../shared/rabbitmq/consumerService');

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWorker(logger) {
  const common = getCommonConfig('inventory-service');

  const queueNames = {
    main: process.env.INVENTORY_QUEUE || 'inventory_queue',
    retry: process.env.INVENTORY_RETRY_QUEUE || 'inventory_retry_queue',
    dlq: process.env.INVENTORY_DLQ || 'inventory_dlq'
  };

  const processingMs = parseNumber(process.env.INVENTORY_PROCESSING_MS, 300);
  const eventStore = new InMemoryEventStore(parseNumber(process.env.IDEMPOTENCY_CACHE_SIZE, 10000));

  logger.info('Inventory worker configuration loaded', {
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
      logger.info('Reserving stock', {
        eventId: event.eventId,
        orderId: event.orderId,
        items: event.payload.items
      });

      await sleep(processingMs);

      logger.info('Stock reserved', {
        eventId: event.eventId,
        orderId: event.orderId
      });
    }
  });
}

module.exports = {
  startWorker
};
