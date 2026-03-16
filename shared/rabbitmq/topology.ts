// shared/rabbitmq/topology.ts

// Topic exchange for choreography saga
export const ORDER_EXCHANGE = "order.topic";

// Routing keys for saga events
export const RoutingKeys = {
  ORDER_CREATED: "order.created",
  PAYMENT_COMPLETED: "payment.completed",
  PAYMENT_FAILED: "payment.failed",
  INVENTORY_RESERVED: "inventory.reserved",
  INVENTORY_FAILED: "inventory.failed",
  PAYMENT_REFUND_REQUESTED: "payment.refund.requested",
  PAYMENT_REFUNDED: "payment.refunded",
  ORDER_CONFIRMED: "order.confirmed",
  ORDER_CANCELLED: "order.cancelled",
} as const;

export type RoutingKey = (typeof RoutingKeys)[keyof typeof RoutingKeys];

// Event types
export const EventTypes = {
  ORDER_CREATED: "OrderCreated",
  PAYMENT_COMPLETED: "PaymentCompleted",
  PAYMENT_FAILED: "PaymentFailed",
  INVENTORY_RESERVED: "InventoryReserved",
  INVENTORY_FAILED: "InventoryFailed",
  PAYMENT_REFUND_REQUESTED: "PaymentRefundRequested",
  PAYMENT_REFUNDED: "PaymentRefunded",
  ORDER_CONFIRMED: "OrderConfirmed",
  ORDER_CANCELLED: "OrderCancelled",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

// Map event types to routing keys
export const EventTypeToRoutingKey: Record<EventType, RoutingKey> = {
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

import type { Channel } from "amqplib";

export async function assertOrderExchange(
  channel: Channel,
  exchangeName: string
): Promise<void> {
  await channel.assertExchange(exchangeName, "topic", { durable: true });
}

export async function bindQueueWithRoutingKey(
  channel: Channel,
  exchangeName: string,
  queueName: string,
  routingKey: string
): Promise<void> {
  await channel.bindQueue(queueName, exchangeName, routingKey);
}

export async function setupOutboxPublisher(
  channel: Channel,
  exchangeName: string
): Promise<void> {
  await assertOrderExchange(channel, exchangeName);
}

export interface ConsumerTopologyConfig {
  exchangeName: string;
  mainQueue: string;
  retryQueue: string;
  dlqQueue: string;
  retryDelayMs: number;
  routingKeys?: string[];
}

export async function setupConsumerTopology(
  channel: Channel,
  config: ConsumerTopologyConfig
): Promise<void> {
  const {
    exchangeName,
    mainQueue,
    retryQueue,
    dlqQueue,
    retryDelayMs,
    routingKeys = [],
  } = config;

  await assertOrderExchange(channel, exchangeName);

  await channel.assertQueue(mainQueue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": retryQueue,
    },
  });

  await channel.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": mainQueue,
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
