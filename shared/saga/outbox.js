// Outbox helper functions for writing events to outbox table

const { v4: uuidv4 } = require('uuid');
const { EventTypeToRoutingKey } = require('../rabbitmq/topology');

/**
 * Write an event to the outbox table
 * @param {Object} client - Database client (must be in a transaction)
 * @param {Object} eventData - Event data
 * @param {string} eventData.type - Event type (e.g., 'OrderCreated')
 * @param {string} eventData.sagaId - Saga ID
 * @param {string} eventData.orderId - Order ID
 * @param {Object} eventData.payload - Event payload
 * @param {string} eventData.correlationId - Optional correlation ID
 * @returns {Object} - The created event
 */
async function writeEventToOutbox(client, eventData) {
  const {
    type,
    sagaId,
    orderId,
    payload,
    correlationId = null,
  } = eventData;

  const eventId = uuidv4();
  const routingKey = EventTypeToRoutingKey[type];
  
  if (!routingKey) {
    throw new Error(`Unknown event type: ${type}`);
  }

  const eventPayload = {
    eventId,
    sagaId,
    orderId,
    timestamp: new Date().toISOString(),
    payload,
  };

  await client.query(
    `INSERT INTO events (id, type, payload, routing_key, saga_id, correlation_id) 
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [eventId, type, JSON.stringify(eventPayload), routingKey, sagaId, correlationId]
  );

  return {
    eventId,
    type,
    routingKey,
    payload: eventPayload,
  };
}

/**
 * Check if an event has already been processed (idempotency)
 * @param {Object} client - Database client
 * @param {string} eventId - Event ID to check
 * @returns {boolean}
 */
async function isEventProcessed(client, eventId) {
  const result = await client.query(
    'SELECT 1 FROM processed_events WHERE event_id = $1',
    [eventId]
  );
  return result.rowCount > 0;
}

/**
 * Mark an event as processed (idempotency)
 * @param {Object} client - Database client (must be in a transaction)
 * @param {string} eventId - Event ID to mark
 */
async function markEventAsProcessed(client, eventId) {
  await client.query(
    'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [eventId]
  );
}

module.exports = {
  writeEventToOutbox,
  isEventProcessed,
  markEventAsProcessed,
};
