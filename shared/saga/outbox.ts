// shared/saga/outbox.ts
import { v4 as uuidv4, validate as uuidValidate } from "uuid";
import type { PoolClient } from "pg";
import { EventTypeToRoutingKey, EventType } from "../rabbitmq/topology";

export interface OutboxEventData {
  type: EventType;
  sagaId: string;
  orderId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
}

export interface OutboxEventResult {
  eventId: string;
  type: EventType;
  routingKey: string;
  payload: Record<string, unknown>;
}

/**
 * Write an event to the outbox table (must be called inside a transaction).
 */
export async function writeEventToOutbox(
  client: PoolClient,
  eventData: OutboxEventData
): Promise<OutboxEventResult> {
  const { type, sagaId, orderId, payload, correlationId = null } = eventData;
  const safeCorrelationId =
    correlationId && uuidValidate(correlationId) ? correlationId : null;

  const eventId = uuidv4();
  const routingKey = EventTypeToRoutingKey[type];

  if (!routingKey) {
    throw new Error(`Unknown event type: ${type}`);
  }

  const eventPayload = {
    eventId,
    sagaId,
    correlationId: safeCorrelationId,
    orderId,
    timestamp: new Date().toISOString(),
    payload,
  };

  await client.query(
    `INSERT INTO events (id, type, payload, routing_key, saga_id, correlation_id) 
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      eventId,
      type,
      JSON.stringify(eventPayload),
      routingKey,
      sagaId,
      safeCorrelationId,
    ]
  );

  return {
    eventId,
    type,
    routingKey,
    payload: eventPayload,
  };
}
