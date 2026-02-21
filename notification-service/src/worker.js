const { getCommonConfig } = require("../../shared/config/env");
const { startConsumerService } = require("../../shared/rabbitmq/consumerService");
const { RoutingKeys } = require("../../shared/rabbitmq/topology");
const { parseNumber } = require("../../shared/utils/parseNumber");

// Simple in-memory event store for idempotency (no DB needed for notification service)
class InMemoryEventStore {
  constructor() {
    this.processedEvents = new Set();
  }

  async tryAcquire(eventId) {
    if (this.processedEvents.has(eventId)) {
      return false;
    }
    this.processedEvents.add(eventId);
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWorker(logger) {
  const common = getCommonConfig("notification-service");
  const exchangeName = process.env.ORDER_EXCHANGE || "order.topic";

  const queueNames = {
    main: process.env.NOTIFICATION_QUEUE || "notification_queue",
    retry: process.env.NOTIFICATION_RETRY_QUEUE || "notification_retry_queue",
    dlq: process.env.NOTIFICATION_DLQ || "notification_dlq",
  };

  const processingMs = parseNumber(process.env.NOTIFICATION_PROCESSING_MS, 250);
  const eventStore = new InMemoryEventStore();

  logger.info("Notification worker configuration loaded", {
    queueNames,
    processingMs,
    exchangeName,
  });

  return startConsumerService({
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
      RoutingKeys.ORDER_CONFIRMED,
      RoutingKeys.ORDER_CANCELLED,
      RoutingKeys.PAYMENT_REFUNDED,
    ],
    processEvent: async (event, context) => {
      const { logger } = context;
      const routingKey = event.routingKey || "";

      logger.info("Processing notification", {
        eventId: event.eventId,
        sagaId: event.sagaId,
        orderId: event.orderId,
        routingKey,
        customerEmail: event.payload.customerEmail,
      });

      await sleep(processingMs);

      // Route to appropriate notification handler
      switch (routingKey) {
        case RoutingKeys.ORDER_CONFIRMED:
          await sendOrderConfirmation(event, logger);
          break;
        case RoutingKeys.ORDER_CANCELLED:
          await sendOrderCancellation(event, logger);
          break;
        case RoutingKeys.PAYMENT_REFUNDED:
          await sendRefundNotification(event, logger);
          break;
        default:
          logger.warn("Unknown notification type", { routingKey });
      }
    },
  });
}

async function sendOrderConfirmation(event, logger) {
  const { payload } = event;
  
  // In a real system, this would call an email service
  logger.info("SENDING ORDER CONFIRMATION EMAIL", {
    to: payload.customerEmail,
    subject: "Your order has been confirmed!",
    orderId: event.orderId,
    items: payload.items,
    amount: payload.amount,
    currency: payload.currency,
  });

  logger.info("Order confirmation notification sent", {
    eventId: event.eventId,
    sagaId: event.sagaId,
  });
}

async function sendOrderCancellation(event, logger) {
  const { payload } = event;
  
  let subject, message;
  
  switch (payload.reason) {
    case "payment_failed":
      subject = "Your order could not be processed - Payment Failed";
      message = "Unfortunately, we couldn't process your payment. Please try again with a different payment method.";
      break;
    case "timeout":
      subject = "Your order has been cancelled - Timeout";
      message = "Your order could not be completed within the required time and has been cancelled.";
      break;
    case "compensation":
      subject = "Your order has been cancelled - Refund Issued";
      message = `Your order has been cancelled and a refund of ${payload.refundAmount} has been issued.`;
      break;
    default:
      subject = "Your order has been cancelled";
      message = "Your order has been cancelled.";
  }

  logger.info("SENDING ORDER CANCELLATION EMAIL", {
    to: payload.customerEmail,
    subject,
    message,
    orderId: event.orderId,
    reason: payload.reason,
  });

  logger.info("Order cancellation notification sent", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    reason: payload.reason,
  });
}

async function sendRefundNotification(event, logger) {
  const { payload } = event;
  
  logger.info("SENDING REFUND CONFIRMATION EMAIL", {
    to: payload.customerEmail,
    subject: "Refund processed",
    orderId: event.orderId,
    amount: payload.amount,
    currency: payload.currency,
    reason: payload.reason,
  });

  logger.info("Refund notification sent", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    amount: payload.amount,
  });
}

module.exports = {
  startWorker,
};
