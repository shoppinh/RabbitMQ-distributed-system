// shared/rabbitmq/message.ts
import type { Channel, ConfirmChannel, ConsumeMessage } from "amqplib";

export interface OutboxEventRow {
  id: string;
  type: string;
  routing_key: string;
  payload: string; // JSON string as stored in DB
}

export interface DlqMeta {
  reason?: string;
  sourceQueue?: string;
  serviceName?: string;
}

export function publishJson(
  channel: Channel,
  exchange: string,
  routingKey: string,
  message: unknown,
  properties: Record<string, unknown> = {}
): boolean {
  const body = Buffer.from(JSON.stringify(message));
  return channel.publish(exchange, routingKey, body, {
    persistent: true,
    contentType: "application/json",
    ...properties,
  });
}

export async function publishJsonConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  message: unknown,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const body = Buffer.from(JSON.stringify(message));

  await new Promise<void>((resolve, reject) => {
    channel.publish(
      exchange,
      routingKey,
      body,
      {
        persistent: true,
        contentType: "application/json",
        ...properties,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Publish outbox event with confirmation.
 */
export async function publishOutboxEventConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  event: OutboxEventRow
): Promise<void> {
  const { routing_key, payload, id, type } = event;

  await publishJsonConfirmed(channel, exchange, routing_key, JSON.parse(payload), {
    messageId: id,
    type,
  });
}

export function parseJsonMessage(msg: ConsumeMessage): unknown {
  const raw = msg.content.toString();
  return JSON.parse(raw);
}

export function getRejectCount(
  msg: ConsumeMessage,
  sourceQueueName: string
): number {
  const xDeath = msg.properties?.headers?.["x-death"] as
    | Array<{ queue: string; reason: string; count: number }>
    | undefined;
  if (!Array.isArray(xDeath)) {
    return 0;
  }

  const rejectEntry = xDeath.find(
    (entry) =>
      entry.queue === sourceQueueName && entry.reason === "rejected"
  );

  return rejectEntry ? Number(rejectEntry.count) : 0;
}

export function publishToDlq(
  channel: Channel,
  dlqQueue: string,
  msg: ConsumeMessage,
  meta: DlqMeta = {}
): boolean {
  const headers = {
    ...msg.properties?.headers,
    "x-final-failure-reason": meta.reason ?? "Unknown failure",
    "x-final-failure-at": new Date().toISOString(),
    "x-source-queue": meta.sourceQueue ?? "",
    "x-service-name": meta.serviceName ?? "",
  };

  return channel.publish("", dlqQueue, msg.content, {
    persistent: true,
    contentType: msg.properties.contentType ?? "application/json",
    headers,
    messageId: msg.properties.messageId,
    timestamp: Date.now(),
    type: msg.properties.type ?? "Unknown",
  });
}
