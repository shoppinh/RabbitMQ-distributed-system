async function assertOrderExchange(channel, exchangeName) {
  await channel.assertExchange(exchangeName, "fanout", { durable: true });
}

async function bindQueue(channel, exchangeName, queueName) {
  await channel.bindQueue(queueName, exchangeName, "");
}

async function setupOutboxPublisher(channel, exchangeName) {
  await assertOrderExchange(channel, exchangeName);
}

async function setupConsumerTopology(channel, config) {
  const { exchangeName, mainQueue, retryQueue, dlqQueue, retryDelayMs } =
    config;

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

  await bindQueue(channel, exchangeName, mainQueue);
}

module.exports = {
  assertOrderExchange,
  bindQueue,
  setupOutboxPublisher,
  setupConsumerTopology,
};
