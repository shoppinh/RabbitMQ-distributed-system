function publishJson(channel, exchange, routingKey, message, properties = {}) {
  const body = Buffer.from(JSON.stringify(message));

  return channel.publish(exchange, routingKey, body, {
    persistent: true,
    contentType: 'application/json',
    ...properties
  });
}

async function publishJsonConfirmed(
  channel,
  exchange,
  routingKey,
  message,
  properties = {}
) {
  const body = Buffer.from(JSON.stringify(message));

  await new Promise((resolve, reject) => {
    channel.publish(
      exchange,
      routingKey,
      body,
      {
        persistent: true,
        contentType: 'application/json',
        ...properties
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

function parseJsonMessage(msg) {
  if (!msg) {
    return null;
  }

  const raw = msg.content.toString();
  return JSON.parse(raw);
}

function getRejectCount(msg, sourceQueueName) {
  const xDeath = msg.properties?.headers?.['x-death'];
  if (!Array.isArray(xDeath)) {
    return 0;
  }

  const rejectEntry = xDeath.find(
    (entry) => entry.queue === sourceQueueName && entry.reason === 'rejected'
  );

  return rejectEntry ? Number(rejectEntry.count) : 0;
}

function publishToDlq(channel, dlqQueue, msg, meta = {}) {
  const headers = {
    ...msg.properties?.headers,
    'x-final-failure-reason': meta.reason || 'Unknown failure',
    'x-final-failure-at': new Date().toISOString(),
    'x-source-queue': meta.sourceQueue || '',
    'x-service-name': meta.serviceName || ''
  };

  return channel.publish('', dlqQueue, msg.content, {
    persistent: true,
    contentType: msg.properties.contentType || 'application/json',
    headers,
    messageId: msg.properties.messageId,
    timestamp: Date.now(),
    type: msg.properties.type || 'OrderCreated'
  });
}

module.exports = {
  publishJson,
  publishJsonConfirmed,
  parseJsonMessage,
  getRejectCount,
  publishToDlq
};
