// Topic exchange for choreography saga
const ORDER_EXCHANGE = 'order.topic';

// Routing keys for saga events
const RoutingKeys = {
  ORDER_CREATED: 'order.created',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_FAILED: 'inventory.failed',
  PAYMENT_REFUND_REQUESTED: 'payment.refund.requested',
  PAYMENT_REFUNDED: 'payment.refunded',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
};

// Event types
const EventTypes = {
  ORDER_CREATED: 'OrderCreated',
  PAYMENT_COMPLETED: 'PaymentCompleted',
  PAYMENT_FAILED: 'PaymentFailed',
  INVENTORY_RESERVED: 'InventoryReserved',
  INVENTORY_FAILED: 'InventoryFailed',
  PAYMENT_REFUND_REQUESTED: 'PaymentRefundRequested',
  PAYMENT_REFUNDED: 'PaymentRefunded',
  ORDER_CONFIRMED: 'OrderConfirmed',
  ORDER_CANCELLED: 'OrderCancelled',
};

// Map event types to routing keys
const EventTypeToRoutingKey = {
  [EventTypes.ORDER_CREATED]: RoutingKeys.ORDER_CREATED,
  [EventTypes.PAYMENT_COMPLETED]: RoutingKeys.PAYMENT_COMPLETED,
  [EventTypes.PAYMENT_FAILED]: RoutingKeys.PAYMENT_FAILED,
  [EventTypes.INVENTORY_RESERVED]: RoutingKeys.INVENTORY_RESERVED,
  [EventTypes.INVENTORY_FAILED]: RoutingKeys.INVENTORY_FAILED,
  [EventTypes.PAYMENT_REFUND_REQUESTED]: RoutingKeys.PAYMENT_REFUND_REQUESTED,
  [EventTypes.PAYMENT_REFUNDED]: RoutingKeys.PAYMENT_REFUNDED,
  [EventTypes.ORDER_CONFIRMED]: RoutingKeys.ORDER_CONFIRMED,
  [EventTypes.ORDER_CANCELLED]: RoutingKeys.ORDER_CANCELLED,
};

async function assertOrderExchange(channel, exchangeName) {
  await channel.assertExchange(exchangeName, 'topic', { durable: true });
}

async function bindQueueWithRoutingKey(channel, exchangeName, queueName, routingKey) {
  await channel.bindQueue(queueName, exchangeName, routingKey);
}

async function setupOutboxPublisher(channel, exchangeName) {
  await assertOrderExchange(channel, exchangeName);
}

async function setupConsumerTopology(channel, config) {
  const { 
    exchangeName, 
    mainQueue, 
    retryQueue, 
    dlqQueue, 
    retryDelayMs,
    routingKeys = [] 
  } = config;

  await assertOrderExchange(channel, exchangeName);

  await channel.assertQueue(mainQueue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': retryQueue,
    },
  });

  await channel.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      'x-message-ttl': retryDelayMs,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': mainQueue,
    },
  });

  await channel.assertQueue(dlqQueue, {
    durable: true,
  });

  // Bind to multiple routing keys for topic exchange
  for (const routingKey of routingKeys) {
    await bindQueueWithRoutingKey(channel, exchangeName, mainQueue, routingKey);
  }
}

module.exports = {
  ORDER_EXCHANGE,
  RoutingKeys,
  EventTypes,
  EventTypeToRoutingKey,
  assertOrderExchange,
  bindQueueWithRoutingKey,
  setupOutboxPublisher,
  setupConsumerTopology,
};
