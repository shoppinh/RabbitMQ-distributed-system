// shared/rabbitmq/consumerService.ts
import type { Channel } from "amqplib";
import { createChannel } from "./connection";
import { setupConsumerTopology } from "./topology";
import { parseJsonMessage, getRejectCount, publishToDlq } from "./message";
import type { Logger } from "./connection";
import { BaseEventSchema } from "../schemas/eventSchemas";

export interface QueueNames {
  main: string;
  retry: string;
  dlq: string;
}

export interface ConsumerServiceConfig {
  serviceName: string;
  logger: Logger;
  rabbitmqUrl: string;
  exchangeName: string;
  queueNames: QueueNames;
  retryDelayMs: number;
  prefetchCount: number;
  maxRetries: number;
  eventStore: EventStore;
  processEvent: (
    event: ConsumedEvent,
    context: ProcessEventContext
  ) => Promise<void>;
  routingKeys?: string[];
}

export interface EventStore {
  tryAcquire(eventId: string): Promise<boolean>;
}

export interface ProcessEventContext {
  serviceName: string;
  queueNames: QueueNames;
  logger: Logger;
}

export interface ConsumedEvent {
  eventId: string;
  sagaId: string;
  correlationId?: string | null;
  orderId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  routingKey: string;
}

export interface ConsumerService {
  channel: Channel;
  stop(): Promise<void>;
}

function validateEvent(event: unknown): string | null {
  const result = BaseEventSchema.safeParse(event);
  if (!result.success) {
    const firstError = result.error.errors[0];
    return `${firstError.path.join(".")}: ${firstError.message}`;
  }
  return null;
}

export async function startConsumerService(
  config: ConsumerServiceConfig
): Promise<ConsumerService> {
  const {
    serviceName,
    logger,
    rabbitmqUrl,
    exchangeName,
    queueNames,
    retryDelayMs,
    prefetchCount,
    maxRetries,
    eventStore,
    processEvent,
    routingKeys = [],
  } = config;

  const channel = await createChannel({ rabbitmqUrl, logger, serviceName });

  await setupConsumerTopology(channel, {
    exchangeName,
    mainQueue: queueNames.main,
    retryQueue: queueNames.retry,
    dlqQueue: queueNames.dlq,
    retryDelayMs,
    routingKeys,
  });

  await channel.prefetch(prefetchCount);

  logger.info("Consumer topology initialized", {
    queue: queueNames.main,
    retryQueue: queueNames.retry,
    dlqQueue: queueNames.dlq,
    prefetchCount,
    maxRetries,
  });

  channel.consume(
    queueNames.main,
    async (msg) => {
      if (!msg) {
        return;
      }

      let parsedEvent: unknown;

      try {
        parsedEvent = parseJsonMessage(msg);
      } catch (error) {
        const err = error as Error;
        logger.error("Invalid JSON payload; routing message to DLQ", {
          queue: queueNames.main,
          error: err.message,
        });

        await publishToDlq(channel, queueNames.dlq, msg, {
          reason: "Invalid JSON payload",
          sourceQueue: queueNames.main,
          serviceName,
        });

        channel.ack(msg);
        return;
      }

      const validationError = validateEvent(parsedEvent);
      if (validationError) {
        logger.error("Invalid event schema; routing message to DLQ", {
          validationError,
        });

        await publishToDlq(channel, queueNames.dlq, msg, {
          reason: validationError,
          sourceQueue: queueNames.main,
          serviceName,
        });

        channel.ack(msg);
        return;
      }

      // Safe to cast after Zod validation
      const event = parsedEvent as ConsumedEvent;

      // Try to acquire processing lock atomically
      const isFirstSeen = await eventStore.tryAcquire(event.eventId);

      if (!isFirstSeen) {
        logger.warn("Duplicate event detected; ACK without processing", {
          eventId: event.eventId,
          orderId: event.orderId,
        });
        channel.ack(msg);
        return;
      }

      // Add routing key to event for handler routing
      event.routingKey = msg.fields.routingKey;

      try {
        await processEvent(event, { serviceName, queueNames, logger });
        channel.ack(msg);

        logger.info("Event processed successfully", {
          eventId: event.eventId,
          orderId: event.orderId,
        });
      } catch (error) {
        const err = error as Error;
        const rejectCount = getRejectCount(msg, queueNames.main);

        if (rejectCount >= maxRetries) {
          logger.error("Max retries reached; routing message to DLQ", {
            eventId: event.eventId,
            orderId: event.orderId,
            retries: rejectCount,
            error: err.message,
          });

          await publishToDlq(channel, queueNames.dlq, msg, {
            reason: err.message,
            sourceQueue: queueNames.main,
            serviceName,
          });

          channel.ack(msg);
          return;
        }

        logger.warn("Processing failed; NACK message to trigger retry queue", {
          eventId: event.eventId,
          orderId: event.orderId,
          retriesSoFar: rejectCount,
          error: err.message,
        });

        channel.nack(msg, false, false);
      }
    },
    { noAck: false }
  );

  logger.info("Consumer started", {
    queue: queueNames.main,
    workerId: `${serviceName}-${process.pid}`,
  });

  return {
    channel,
    async stop() {
      await channel.close();
      logger.info("Consumer channel closed", { queue: queueNames.main });
    },
  };
}
