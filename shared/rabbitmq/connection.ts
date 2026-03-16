// shared/rabbitmq/connection.ts
import amqp, { ChannelModel, Channel, ConfirmChannel } from "amqplib";

export interface ConnectionConfig {
  rabbitmqUrl: string;
  logger: Logger;
  serviceName: string;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

let connection: ChannelModel | null = null;
let connectionPromise: Promise<ChannelModel> | null = null;

export async function getConnection(config: ConnectionConfig): Promise<ChannelModel> {
  if (connection) {
    return connection;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  const { rabbitmqUrl, logger, serviceName } = config;

  connectionPromise = amqp
    .connect(rabbitmqUrl)
    .then((conn) => {
      connection = conn;
      connectionPromise = null;

      conn.on("error", (error: Error) => {
        logger.error("RabbitMQ connection error", {
          serviceName,
          error: error.message,
        });
      });

      conn.on("close", () => {
        logger.warn("RabbitMQ connection closed", { serviceName });
        connection = null;
        // Reconnect strategy placeholder:
        // A production implementation should trigger controlled reconnect with backoff.
      });

      logger.info("RabbitMQ connection established", { serviceName });
      return conn;
    })
    .catch((error: Error) => {
      connectionPromise = null;
      logger.error("RabbitMQ connection failed", {
        serviceName,
        error: error.message,
      });
      throw error;
    });

  return connectionPromise;
}

export async function createChannel(config: ConnectionConfig): Promise<Channel> {
  const conn = await getConnection(config);
  return conn.createChannel();
}

export async function createConfirmChannel(
  config: ConnectionConfig
): Promise<ConfirmChannel> {
  const conn = await getConnection(config);
  return conn.createConfirmChannel();
}

export async function closeConnection(
  logger: Logger,
  serviceName: string
): Promise<void> {
  if (!connection) {
    return;
  }

  try {
    await connection.close();
    logger.info("RabbitMQ connection closed by service", { serviceName });
  } finally {
    connection = null;
    connectionPromise = null;
  }
}
