# Event-Driven Order Processing System (Node.js + RabbitMQ)

A complete backend microservice project that implements an event-driven order flow using RabbitMQ fanout exchange broadcasting, retry queues, dead-letter queues, idempotent consumers, and horizontal worker scaling support.

## Services

- **Order Service** (`order-service`) - Producer API (`POST /orders`)
- **Payment Service** (`payment-service`) - Consumer with random failure simulation
- **Inventory Service** (`inventory-service`) - Consumer that reserves stock
- **Notification Service** (`notification-service`) - Consumer that sends notifications
- **Shared module** (`shared`) - RabbitMQ connection manager, topology helpers, messaging helpers, env config, in-memory idempotency store

## Architecture Highlights

- Node.js + Express + amqplib
- Exchange: `order_exchange` (type `fanout`)
- Main queues:
  - `payment_queue`
  - `inventory_queue`
  - `notification_queue`
- Per-service retry and DLQ queues:
  - `payment_retry_queue`, `payment_dlq`
  - `inventory_retry_queue`, `inventory_dlq`
  - `notification_retry_queue`, `notification_dlq`
- Consumer reliability:
  - `prefetch(1)`
  - retry with dead-letter routing + TTL
  - DLQ fallback on permanent failure
  - idempotent consumption via in-memory `eventId` tracking
  - proper ACK / NACK behavior
- Exactly one RabbitMQ connection per service process (singleton module)
- Horizontal scaling by running multiple worker instances per service

## Event Contract

Every published event includes:

```json
{
  "eventId": "uuid",
  "orderId": "uuid",
  "timestamp": "ISO-8601",
  "payload": {
    "customerId": "string|null",
    "customerEmail": "string|null",
    "items": [],
    "amount": 0,
    "currency": "USD"
  }
}
```

## Retry Flow

Implemented using:

- `x-dead-letter-exchange`
- `x-dead-letter-routing-key`
- `x-message-ttl`

Message path:

1. Main queue receives event from fanout exchange
2. Consumer processing fails -> `NACK(requeue=false)`
3. Main queue dead-letters message to retry queue
4. Retry queue TTL expires -> dead-letters message back to main queue
5. If retries exceed `MAX_RETRIES`, consumer routes message to DLQ and ACKs original

## Prerequisites

- Node.js 18+
- Docker + Docker Compose

## Setup

1. Install dependencies once at project root:

```bash
npm install
```

2. Start full stack (RabbitMQ + all microservices):

```bash
docker compose up -d
```

RabbitMQ UI: `http://localhost:15672`  
Credentials: `guest / guest`

Order Service API: `http://localhost:3000`

## Run Services Manually (Alternative)

If you prefer local Node processes instead of service containers, run each service in its own terminal from project root:

```bash
node order-service/index.js
node payment-service/index.js
node inventory-service/index.js
node notification-service/index.js
```

Order Service API runs on `http://localhost:3000`.

## Create an Order (Trigger Event)

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust-1001",
    "customerEmail": "user@example.com",
    "items": [{"sku":"SKU-1","qty":2}],
    "amount": 125.50,
    "currency": "USD"
  }'
```

This publishes `OrderCreated` to `order_exchange`, and all three consumers receive it via their own queue bindings.

## Environment Variables

Common (all services):

- `RABBITMQ_URL` (default: `amqp://guest:guest@localhost:5672`)
- `ORDER_EXCHANGE` (default: `order_exchange`)
- `RETRY_DELAY_MS` (default: `5000`)
- `MAX_RETRIES` (default: `3`)
- `PREFETCH_COUNT` (default: `1`)
- `IDEMPOTENCY_CACHE_SIZE` (default: `10000`)

Order service:

- `PORT` (default: `3000`)

Payment service:

- `PAYMENT_QUEUE` (default: `payment_queue`)
- `PAYMENT_RETRY_QUEUE` (default: `payment_retry_queue`)
- `PAYMENT_DLQ` (default: `payment_dlq`)
- `PAYMENT_FAILURE_RATE` (default: `0.5`)
- `PAYMENT_PROCESSING_MS` (default: `600`)

Inventory service:

- `INVENTORY_QUEUE` (default: `inventory_queue`)
- `INVENTORY_RETRY_QUEUE` (default: `inventory_retry_queue`)
- `INVENTORY_DLQ` (default: `inventory_dlq`)
- `INVENTORY_PROCESSING_MS` (default: `300`)

Notification service:

- `NOTIFICATION_QUEUE` (default: `notification_queue`)
- `NOTIFICATION_RETRY_QUEUE` (default: `notification_retry_queue`)
- `NOTIFICATION_DLQ` (default: `notification_dlq`)
- `NOTIFICATION_PROCESSING_MS` (default: `250`)

## Horizontal Worker Scaling

To scale a worker, run additional instances of the same service:

```bash
node payment-service/index.js
node payment-service/index.js
node payment-service/index.js
```

RabbitMQ load-balances messages across worker instances consuming the same queue.

## Testing Retry Flow

1. Start services.
2. Set `PAYMENT_FAILURE_RATE=0.9` (or keep default `0.5`) for frequent failures.
3. Submit orders.
4. Observe logs showing:
   - processing failure
   - `NACK` from main queue
   - delayed reprocessing after retry TTL

## Testing DLQ Flow

1. Start payment service with guaranteed failure and low retry limit:

```bash
MAX_RETRIES=2 PAYMENT_FAILURE_RATE=1 node payment-service/index.js
```

2. Submit an order.
3. In RabbitMQ UI, inspect queue `payment_dlq` to confirm failed message landed in DLQ after retries.

## Testing Duplicate Event Protection

1. Submit an order and copy the event payload from logs/response.
2. Re-publish the exact same event with the same `eventId` to `order_exchange` from RabbitMQ UI.
3. Consumer logs should show duplicate detection and immediate ACK without reprocessing.

## Notes

- No database persistence in this phase.
- No transactional outbox pattern implemented.
- No saga orchestration.
- No Kafka/streaming system usage.
