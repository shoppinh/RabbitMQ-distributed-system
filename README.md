# Event-Driven Order Processing System with Choreography Saga Pattern

A complete backend microservice project implementing a **Choreography Saga Pattern** with **Outbox Pattern** for distributed transactions. Built with Node.js, RabbitMQ (topic exchange), and PostgreSQL.

## Architecture Overview

This system implements an order processing flow using **choreography-based saga pattern** where services communicate via events to coordinate distributed transactions.

### Saga Flows

**Happy Path:**
```
OrderCreated → PaymentCompleted → InventoryReserved → OrderConfirmed
```

**Payment Failure:**
```
OrderCreated → PaymentFailed → OrderCancelled
```

**Inventory Failure (Compensation):**
```
OrderCreated → PaymentCompleted → InventoryFailed → PaymentRefundRequested → PaymentRefunded → OrderCancelled
```

**Timeout (90 seconds):**
```
OrderCreated → [90s timeout] → OrderCancelled
```

## Services

| Service | Purpose | Database | Outbox Pattern |
|---------|---------|----------|----------------|
| **Order Service** | Saga coordinator, HTTP API | `order_db` | ✅ Yes |
| **Payment Service** | Process payments & refunds | `payment_db` | ✅ Yes |
| **Inventory Service** | Reserve stock | `inventory_db` | ✅ Yes |
| **Notification Service** | Send emails (stateless) | None | ❌ No |

## Architecture Highlights

- **Exchange Type**: `topic` (not fanout) - enables selective event routing
- **Exchange Name**: `order.topic`
- **Outbox Pattern**: Each service with a database uses outbox for reliable event publishing
- **Saga Timeout**: 90-second automatic cancellation for stuck sagas
- **Compensation**: Automatic refund flow when inventory reservation fails
- **Idempotency**: Per-event deduplication via `processed_events` table
- **Exactly-once Publishing**: Confirm channels with publisher acknowledgments
- **Retry & DLQ**: Per-service retry queues with TTL and dead-letter queues

## Event Contract

All events include:

```json
{
  "eventId": "uuid",
  "sagaId": "uuid",
  "orderId": "uuid",
  "timestamp": "ISO-8601",
  "payload": { ... }
}
```

## Routing Keys

| Event | Routing Key | Published By |
|-------|-------------|--------------|
| OrderCreated | `order.created` | Order Service |
| PaymentCompleted | `payment.completed` | Payment Service |
| PaymentFailed | `payment.failed` | Payment Service |
| InventoryReserved | `inventory.reserved` | Inventory Service |
| InventoryFailed | `inventory.failed` | Inventory Service |
| PaymentRefundRequested | `payment.refund.requested` | Order Service |
| PaymentRefunded | `payment.refunded` | Payment Service |
| OrderConfirmed | `order.confirmed` | Order Service |
| OrderCancelled | `order.cancelled` | Order Service |

## Database Schema

### Order Service (`order_db`)
- `orders` - Order data
- `events` - Outbox table
- `saga_instances` - Saga state tracking
- `processed_events` - Idempotency

### Payment Service (`payment_db`)
- `payment_transactions` - Payment state
- `events` - Outbox table
- `processed_events` - Idempotency

### Inventory Service (`inventory_db`)
- `inventory_reservations` - Reservation state
- `events` - Outbox table
- `processed_events` - Idempotency

## Prerequisites

- Node.js 18+
- Docker + Docker Compose

## Setup

1. **Install dependencies:**

```bash
npm install
```

2. **Start full stack:**

```bash
docker compose up -d
```

This starts:
- PostgreSQL with 3 databases (order_db, payment_db, inventory_db)
- RabbitMQ with management UI
- Database migrators for each service
- All microservices

**RabbitMQ UI**: `http://localhost:15672` (guest/guest)  
**Order Service API**: `http://localhost:3000`

3. **Check migration status:**

```bash
docker compose logs db-migrator-order
docker compose logs db-migrator-payment
docker compose logs db-migrator-inventory
```

You should see `[migrate] done` for each.

## Create an Order (Trigger Saga)

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

Response:
```json
{
  "status": "accepted",
  "orderId": "uuid",
  "sagaId": "uuid",
  "message": "Order created, saga started"
}
```

## Check Saga Status

```bash
curl http://localhost:3000/sagas/{sagaId}
```

## Environment Variables

### Order Service
```
PORT=3000
DB_HOST=postgres-order
DB_PORT=5432
DB_NAME=order_db
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
ORDER_EXCHANGE=order.topic
SAGA_TIMEOUT_MS=90000
TIMEOUT_CHECK_INTERVAL_MS=10000
OUTBOX_POLL_INTERVAL_MS=1000
```

### Payment Service
```
DB_HOST=postgres-payment
DB_PORT=5432
DB_NAME=payment_db
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
ORDER_EXCHANGE=order.topic
PAYMENT_QUEUE=payment_queue
PAYMENT_FAILURE_RATE=0.3
OUTBOX_POLL_INTERVAL_MS=1000
```

### Inventory Service
```
DB_HOST=postgres-inventory
DB_PORT=5432
DB_NAME=inventory_db
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
ORDER_EXCHANGE=order.topic
INVENTORY_QUEUE=inventory_queue
INVENTORY_FAILURE_RATE=0.2
OUTBOX_POLL_INTERVAL_MS=1000
```

### Notification Service
```
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
ORDER_EXCHANGE=order.topic
NOTIFICATION_QUEUE=notification_queue
```

## Testing Different Scenarios

### Test Happy Path

```bash
# Set low failure rates in docker-compose.yml
PAYMENT_FAILURE_RATE=0
INVENTORY_FAILURE_RATE=0

docker compose up -d
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"customerEmail":"test@example.com","items":[{"sku":"A1","qty":1}],"amount":100}'
```

### Test Payment Failure

```bash
# Set high payment failure rate
PAYMENT_FAILURE_RATE=1.0

curl -X POST http://localhost:3000/orders ...
# Should result in OrderCancelled with reason="payment_failed"
```

### Test Inventory Failure (Compensation)

```bash
# Set payment success but inventory failure
PAYMENT_FAILURE_RATE=0
INVENTORY_FAILURE_RATE=1.0

curl -X POST http://localhost:3000/orders ...
# Should result in PaymentRefunded → OrderCancelled with reason="compensation"
```

### Test Timeout

```bash
# Set payment processing very slow
PAYMENT_PROCESSING_MS=120000

# Or manually block payment service
docker compose stop payment-service

curl -X POST http://localhost:3000/orders ...
# After 90 seconds, should timeout and cancel
```

## Horizontal Scaling

Scale any service by running multiple instances:

```bash
docker compose up -d --scale payment-service=3
```

RabbitMQ load-balances messages across worker instances.

## Implementation Notes

### Outbox Pattern
Each service with a database runs an embedded outbox worker that:
1. Polls the `events` table for unpublished events
2. Publishes to RabbitMQ with publisher confirms
3. Marks events as published

### Saga Timeout
Order Service runs a timeout checker that:
1. Polls `saga_instances` for pending sagas past `timeout_at`
2. Writes `OrderCancelled` to outbox with reason="timeout"
3. Updates saga status to `timeout_cancelled`

### Idempotency
All event consumers use the `processed_events` table to ensure exactly-once processing per event.

### Transaction Boundaries
All database operations within a single event handler use database transactions to ensure atomicity.

## Project Structure

```
.
├── order-service/
│   ├── config/db.js          # Service-specific DB config
│   ├── src/
│   │   ├── server.js         # HTTP API + saga consumers
│   │   ├── sagaHandler.js    # Saga state transitions
│   │   ├── outboxWorker.js   # Embedded outbox publisher
│   │   └── timeoutChecker.js # Saga timeout checker
│   └── index.js
├── payment-service/
│   ├── config/db.js
│   ├── src/
│   │   ├── worker.js         # Event consumer (OrderCreated, RefundRequest)
│   │   └── outboxWorker.js   # Embedded outbox publisher
│   └── index.js
├── inventory-service/
│   ├── config/db.js
│   ├── src/
│   │   ├── worker.js         # Event consumer (PaymentCompleted)
│   │   └── outboxWorker.js   # Embedded outbox publisher
│   └── index.js
├── notification-service/
│   └── src/worker.js         # Event consumer (stateless)
├── shared/
│   ├── saga/
│   │   ├── sagaState.js      # Saga state machine
│   │   └── outbox.js         # Outbox helper functions
│   └── rabbitmq/
│       ├── topology.js       # Topic exchange setup
│       └── consumerService.js
└── database/migrations/
    ├── order/001_init.sql
    ├── payment/001_init.sql
    └── inventory/001_init.sql
```

## License

MIT
