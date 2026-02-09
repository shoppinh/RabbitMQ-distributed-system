const amqp = require('amqplib');

let connection = null;
let connectionPromise = null;

async function getConnection({ rabbitmqUrl, logger, serviceName }) {
  if (connection) {
    return connection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = amqp
    .connect(rabbitmqUrl)
    .then((conn) => {
      connection = conn;
      connectionPromise = null;

      conn.on('error', (error) => {
        logger.error('RabbitMQ connection error', {
          serviceName,
          error: error.message
        });
      });

      conn.on('close', () => {
        logger.warn('RabbitMQ connection closed', { serviceName });
        connection = null;
        // Reconnect strategy placeholder:
        // A production implementation should trigger controlled reconnect with backoff.
      });

      logger.info('RabbitMQ connection established', { serviceName });
      return conn;
    })
    .catch((error) => {
      connectionPromise = null;
      logger.error('RabbitMQ connection failed', {
        serviceName,
        error: error.message
      });
      throw error;
    });

  return connectionPromise;
}

async function createChannel(config) {
  const conn = await getConnection(config);
  return conn.createChannel();
}

async function createConfirmChannel(config) {
  const conn = await getConnection(config);
  return conn.createConfirmChannel();
}

async function closeConnection(logger, serviceName) {
  if (!connection) {
    return;
  }

  try {
    await connection.close();
    logger.info('RabbitMQ connection closed by service', { serviceName });
  } finally {
    connection = null;
    connectionPromise = null;
  }
}

module.exports = {
  getConnection,
  createChannel,
  createConfirmChannel,
  closeConnection
};
