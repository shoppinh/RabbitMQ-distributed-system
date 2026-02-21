# Copilot Instructions

## Running the System

```bash
npm install                    # Install root dependencies
docker compose up -d           # Start full stack (Postgres x3, RabbitMQ, all services)
```

**Individual services (outside Docker):**
```bash
npm run start:order
npm run start:payment
npm run start:inventory
npm run start:notification
```

**Run migrations manually:**
```bash
MIGRATIONS_DIR=database/migrations/order DB_NAME=order_db node scripts/migrate.js
```

**RabbitMQ UI:** http://localhost:15672 (guest/guest)  
**Order API:** http://localhost:3000

## Architecture

This is a **Choreography Saga** system — services coordinate distributed transactions by reacting to events, not by being orchestrated. The Order Service acts as the saga state tracker (not orchestrator).

### Saga event flow

```
OrderCreated → PaymentCompleted → InventoryReserved → OrderConfirmed   (happy path)
OrderCreated → PaymentFailed → OrderCancelled                           (payment failure)
OrderCreated → PaymentCompleted → InventoryFailed →
  PaymentRefundRequested → PaymentRefunded → OrderCancelled             (compensation)
```

All events flow through a single **topic exchange** (`order.topic`). Each service binds its queue to specific routing keys.

### Service responsibilities

| Service | Listens to | Publishes |
|---------|-----------|-----------|
| order-service | `payment.*`, `inventory.*`, `payment.refunded` | `order.created`, `payment.refund.requested`, `order.confirmed`, `order.cancelled` |
| payment-service | `order.created`, `payment.refund.requested` | `payment.completed`, `payment.failed`, `payment.refunded` |
| inventory-service | `payment.completed` | `inventory.reserved`, `inventory.failed` |
| notification-service | `order.confirmed`, `order.cancelled` | nothing |

### Key components per service

- **`index.js`** — entry point; loads `.env` from the service directory
- **`src/worker.js`** — RabbitMQ event consumer (payment, inventory, notification services)
- **`src/server.js`** — HTTP API + saga event consumers (order service only)
- **`src/outboxWorker.js`** — polls `events` table and publishes to RabbitMQ (all DB-backed services)
- **`src/sagaHandler.js`** — saga state transitions (order service only)
- **`src/timeoutChecker.js`** — cancels pending sagas after 90s (order service only)
- **`config/db.js`** — service-specific Postgres pool

### Shared modules (`shared/`)

- `rabbitmq/topology.js` — `RoutingKeys`, `EventTypes`, `EventTypeToRoutingKey` constants; `setupConsumerTopology`
- `rabbitmq/consumerService.js` — `startConsumerService()`: wire up a consumer with retry + DLQ logic
- `rabbitmq/connection.js` — connection/channel factory
- `saga/outbox.js` — `writeEventToOutbox()`, `markEventAsProcessed()`
- `saga/sagaState.js` — `SagaStateManager`, `SagaStatus`, `SagaSteps` enums
- `idempotency/eventStore.js` — `DatabaseEventStore.tryAcquire(eventId)` for deduplication
- `config/env.js` — `getCommonConfig()`, `getDatabaseConfig()`

## Key Conventions

### Event schema
All events must include these fields:
```json
{ "eventId": "uuid", "sagaId": "uuid", "orderId": "uuid", "timestamp": "ISO-8601", "payload": {} }
```
`writeEventToOutbox()` in `shared/saga/outbox.js` constructs this automatically.

### Outbox pattern (never publish directly to RabbitMQ from a handler)
Within a DB transaction, write to the `events` table via `writeEventToOutbox(client, { type, sagaId, orderId, payload })`. The embedded `outboxWorker` polls and publishes using publisher confirms. The `type` must be a key in `EventTypeToRoutingKey`; the routing key is derived automatically.

### Idempotency — two-layer approach
1. **`consumerService.js`** calls `DatabaseEventStore.tryAcquire(eventId)` before invoking `processEvent`. If duplicate, it ACKs without processing.
2. **`sagaHandler.js`** (order service) re-checks `processed_events` inside the transaction as a safety net.

### Transaction boundaries
Every event handler opens a DB transaction (`BEGIN`/`COMMIT`/`ROLLBACK`). Business logic, `processed_events` inserts, and `writeEventToOutbox` calls all happen within the same transaction.

### Adding a new event type
1. Add to `RoutingKeys` and `EventTypes` in `shared/rabbitmq/topology.js`
2. Add to `EventTypeToRoutingKey` map in the same file
3. Add the routing key to the consuming service's `routingKeys` array in `startConsumerService`
4. Handle `event.routingKey` in the `processEvent` callback

### Failure simulation
`PAYMENT_FAILURE_RATE` (0–1.0) and `INVENTORY_FAILURE_RATE` (0–1.0) are set per service in `docker-compose.yml` environment variables. Set to `0` for happy path, `1.0` to force failures.

### Migrations
SQL files in `database/migrations/{order,payment,inventory}/` are applied in filename sort order. The runner tracks applied versions in `schema_migrations`. Each service's Docker migrator sets `MIGRATIONS_DIR` and `DB_NAME` env vars before running `node scripts/migrate.js`.

### Each service loads its own `.env`
`index.js` in each service calls `dotenv.config({ path: path.join(__dirname, '.env') })`. The `.env.example` at the root shows shared defaults.
