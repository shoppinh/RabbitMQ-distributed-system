// order-service/src/worker.ts
import { getCommonConfig } from "../../shared/config/env";
import { DatabaseEventStore } from "../../shared/idempotency/eventStore";
import { startConsumerService } from "../../shared/rabbitmq/consumerService";
import { RoutingKeys } from "../../shared/rabbitmq/topology";
import { pool } from "../config/db";
import { SagaStateManager } from "../../shared/saga/sagaState";
import { SagaHandler } from "./sagaHandler";
import type { Logger } from "../../shared/utils/logger";

export async function startWorker(logger: Logger): Promise<void> {
  const common = getCommonConfig("order-service");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  const queueNames = {
    main: process.env.ORDER_QUEUE || "order_service_queue",
    retry: process.env.ORDER_RETRY_QUEUE || "order_service_retry_queue",
    dlq: process.env.ORDER_DLQ || "order_service_dlq",
  };

  const eventStore = new DatabaseEventStore(common.serviceName, pool);
  const sagaManager = new SagaStateManager(pool);
  const sagaHandler = new SagaHandler(pool, sagaManager, logger);

  logger.info("Order worker configuration loaded", {
    queueNames,
    exchangeName,
  });

  await startConsumerService({
    serviceName: common.serviceName,
    logger,
    rabbitmqUrl: common.rabbitmqUrl,
    exchangeName,
    queueNames,
    retryDelayMs: common.retryDelayMs,
    prefetchCount: common.prefetchCount,
    maxRetries: common.maxRetries,
    eventStore,
    routingKeys: [
      RoutingKeys.PAYMENT_COMPLETED,
      RoutingKeys.PAYMENT_FAILED,
      RoutingKeys.INVENTORY_RESERVED,
      RoutingKeys.INVENTORY_FAILED,
      RoutingKeys.PAYMENT_REFUNDED,
    ],
    processEvent: async (event, context) => {
      const { logger } = context;
      const { routingKey } = event;

      logger.info("Received saga event", {
        eventId: event.eventId,
        sagaId: event.sagaId,
        routingKey,
      });

      switch (routingKey) {
        case RoutingKeys.PAYMENT_COMPLETED:
          await sagaHandler.handlePaymentCompleted(event);
          break;
        case RoutingKeys.PAYMENT_FAILED:
          await sagaHandler.handlePaymentFailed(event);
          break;
        case RoutingKeys.INVENTORY_RESERVED:
          await sagaHandler.handleInventoryReserved(event);
          break;
        case RoutingKeys.INVENTORY_FAILED:
          await sagaHandler.handleInventoryFailed(event);
          break;
        case RoutingKeys.PAYMENT_REFUNDED:
          await sagaHandler.handlePaymentRefunded(event);
          break;
        default:
          logger.warn("Unknown routing key", { routingKey });
      }
    },
  });
}
