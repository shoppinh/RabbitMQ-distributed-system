const { createChannel } = require('./connection');
const { setupConsumerTopology } = require('./topology');
const { parseJsonMessage, getRejectCount, publishToDlq } = require('./message');

function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    return 'Event payload is missing or invalid JSON object';
  }

  const requiredFields = ['eventId', 'sagaId', 'orderId', 'timestamp', 'payload'];

  for (const field of requiredFields) {
    if (!event[field]) {
      return `Missing required field: ${field}`;
    }
  }

  return null;
}

async function startConsumerService(config) {
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
    routingKeys = []
  } = config;

  const channel = await createChannel({ rabbitmqUrl, logger, serviceName });

  await setupConsumerTopology(channel, {
    exchangeName,
    mainQueue: queueNames.main,
    retryQueue: queueNames.retry,
    dlqQueue: queueNames.dlq,
    retryDelayMs,
    routingKeys
  });

  await channel.prefetch(prefetchCount);

  logger.info('Consumer topology initialized', {
    queue: queueNames.main,
    retryQueue: queueNames.retry,
    dlqQueue: queueNames.dlq,
    prefetchCount,
    maxRetries
  });

  channel.consume(
    queueNames.main,
    async (msg) => {
      if (!msg) {
        return;
      }

      let event;

      try {
        event = parseJsonMessage(msg);
      } catch (error) {
        logger.error('Invalid JSON payload; routing message to DLQ', {
          queue: queueNames.main,
          error: error.message
        });

        await publishToDlq(channel, queueNames.dlq, msg, {
          reason: 'Invalid JSON payload',
          sourceQueue: queueNames.main,
          serviceName
        });

        channel.ack(msg);
        return;
      }

      const validationError = validateEvent(event);
      if (validationError) {
        logger.error('Invalid event schema; routing message to DLQ', {
          event,
          validationError
        });

        await publishToDlq(channel, queueNames.dlq, msg, {
          reason: validationError,
          sourceQueue: queueNames.main,
          serviceName
        });

        channel.ack(msg);
        return;
      }

      // Try to acquire processing lock atomically
      const isFirstSeen = await eventStore.tryAcquire(event.eventId);
      
      if (!isFirstSeen) {
        logger.warn('Duplicate event detected; ACK without processing', {
          eventId: event.eventId,
          orderId: event.orderId
        });
        channel.ack(msg);
        return;
      }

      // Add routing key to event for routing
      event.routingKey = msg.fields.routingKey;

      try {
        await processEvent(event, {
          serviceName,
          queueNames,
          logger
        });

        channel.ack(msg);

        logger.info('Event processed successfully', {
          eventId: event.eventId,
          orderId: event.orderId
        });
      } catch (error) {
        const rejectCount = getRejectCount(msg, queueNames.main);

        if (rejectCount >= maxRetries) {
          logger.error('Max retries reached; routing message to DLQ', {
            eventId: event.eventId,
            orderId: event.orderId,
            retries: rejectCount,
            error: error.message
          });

          await publishToDlq(channel, queueNames.dlq, msg, {
            reason: error.message,
            sourceQueue: queueNames.main,
            serviceName
          });

          channel.ack(msg);
          return;
        }

        logger.warn('Processing failed; NACK message to trigger retry queue', {
          eventId: event.eventId,
          orderId: event.orderId,
          retriesSoFar: rejectCount,
          error: error.message
        });

        channel.nack(msg, false, false);
      }
    },
    { noAck: false }
  );

  logger.info('Consumer started', {
    queue: queueNames.main,
    workerId: `${serviceName}-${process.pid}`
  });

  return {
    channel,
    async stop() {
      await channel.close();
      logger.info('Consumer channel closed', { queue: queueNames.main });
    }
  };
}

module.exports = {
  startConsumerService
};
