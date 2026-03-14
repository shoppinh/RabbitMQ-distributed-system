const { v4: uuidv4 } = require("uuid");
const { DatabaseEventStore } = require("../../shared/idempotency/eventStore");
const { getCommonConfig } = require("../../shared/config/env");
const { startConsumerService } = require("../../shared/rabbitmq/consumerService");
const { RoutingKeys } = require("../../shared/rabbitmq/topology");
const { parseNumber } = require("../../shared/utils/parseNumber");
const { pool } = require("../config/db");

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
  const eventStore = new DatabaseEventStore(common.serviceName, pool);

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
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        
        switch (routingKey) {
          case RoutingKeys.ORDER_CONFIRMED:
            await sendOrderConfirmation(client, event, logger);
            break;
          case RoutingKeys.ORDER_CANCELLED:
            await sendOrderCancellation(client, event, logger);
            break;
          case RoutingKeys.PAYMENT_REFUNDED:
            await sendRefundNotification(client, event, logger);
            break;
          default:
            logger.warn("Unknown notification type", { routingKey });
        }
        
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

async function sendOrderConfirmation(client, event, logger) {
  const { payload } = event;
  
  const subject = "Your order has been confirmed!";
  const message = `Order ${event.orderId} containing ${payload.items.length} items for ${payload.amount} ${payload.currency} has been confirmed.`;

  // In a real system, this would call an email service
  logger.info("SENDING ORDER CONFIRMATION EMAIL", {
    to: payload.customerEmail,
    subject,
    orderId: event.orderId,
    items: payload.items,
    amount: payload.amount,
    currency: payload.currency,
  });

  // Log to database
  await client.query(
    "INSERT INTO notifications_log (id, saga_id, order_id, type, recipient_email, subject, message) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [uuidv4(), event.sagaId, event.orderId, "order_confirmation", payload.customerEmail, subject, message]
  );

  logger.info("Order confirmation notification sent", {
    eventId: event.eventId,
    sagaId: event.sagaId,
  });
}

async function sendOrderCancellation(client, event, logger) {
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

  // Log to database
  await client.query(
    "INSERT INTO notifications_log (id, saga_id, order_id, type, recipient_email, subject, message) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [uuidv4(), event.sagaId, event.orderId, "order_cancellation", payload.customerEmail, subject, message]
  );

  logger.info("Order cancellation notification sent", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    reason: payload.reason,
  });
}

async function sendRefundNotification(client, event, logger) {
  const { payload } = event;
  
  const subject = "Refund processed";
  const message = `A refund for ${payload.amount} ${payload.currency} has been processed. Reason: ${payload.reason}`;

  logger.info("SENDING REFUND CONFIRMATION EMAIL", {
    to: payload.customerEmail,
    subject,
    orderId: event.orderId,
    amount: payload.amount,
    currency: payload.currency,
    reason: payload.reason,
  });

  // Log to database
  await client.query(
    "INSERT INTO notifications_log (id, saga_id, order_id, type, recipient_email, subject, message) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [uuidv4(), event.sagaId, event.orderId, "refund", payload.customerEmail, subject, message]
  );

  logger.info("Refund notification sent", {
    eventId: event.eventId,
    sagaId: event.sagaId,
    amount: payload.amount,
  });
}

module.exports = {
  startWorker,
};
