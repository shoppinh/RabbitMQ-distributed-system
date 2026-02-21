# Architecture Overview — Choreography Saga with RabbitMQ

This repository implements a distributed transaction pattern using a choreography-based saga with RabbitMQ as the event backbone. The goal is to coordinate state changes across multiple microservices (order, payment, inventory, notification) without a central orchestrator by exchanging domain events over a topic exchange and using strong reliability patterns (outbox, idempotency, publisher confirms).

## Core concepts and purpose

- Choreography Saga: Each service reacts to events and emits subsequent events to advance the saga. This keeps services loosely coupled and allows independent scaling and deployment while maintaining eventual consistency.
- Topic Exchange: A single topic exchange (`order.topic`) routes events to subscribers using routing keys (e.g., `payment.*`, `inventory.*`). This provides flexible routing and enables multiple consumers to react to the same event stream.
- Outbox Pattern: Services persist outbound events in an `events` (outbox) table inside the same DB transaction as domain changes. A separate outbox worker publishes these events to RabbitMQ using publisher confirms, ensuring atomicity between DB write and message publish.
- Publisher Confirms: The publisher uses RabbitMQ confirms (publisher confirms) to guarantee messages are acknowledged by the broker before marking outbox rows as published. This prevents message loss and ensures at-least-once delivery semantics when combined with idempotency.
- Idempotency / Event Store: Consumers call a DatabaseEventStore.tryAcquire(eventId) before processing to deduplicate and ACK duplicates. This two-layered approach (pre-consume acquire + processed_events checks inside transaction) prevents double processing.
- Consumer reliability: Consumers are configured with retry policies and DLQs. The consumer service includes retry/backoff and dead-lettering to separate transient from permanent failures.

## Why this architecture is used (benefits)

- Loose coupling and resilience: Choreography lets each service own its data and logic; failures in one service don't directly break others and can be compensated via compensating events.
- Strong delivery guarantees: Outbox + publisher confirms + idempotency together provide end-to-end reliability: no lost publishes, at-least-once delivery, and safe duplicate handling.
- Observability and replay: Storing events in an outbox and event tables makes it easier to audit, replay, or rebuild state if needed.
- Simpler operational model: A single topic exchange with routing keys is simpler to reason about than many point-to-point integrations and makes adding new consumers straightforward.

## Tradeoffs and considerations

- Increased complexity: Implementing outbox workers, idempotency checks, and compensating flows increases code and operational complexity vs. synchronous/monolithic designs.
- Eventual consistency: Clients must accept eventual consistency and implement UX or retry strategies for pending states.
- Operational burden: You must run and monitor outbox workers and tune retry/DLQ settings; misconfiguration can lead to slow processing or message storms.

## Practical recommendations (short)

- Ensure publisher confirms are enabled and the outbox worker only marks rows published after confirms are received.
- Keep the DatabaseEventStore.tryAcquire(eventId) and processed_events checks consistent and idempotent across services.
- Configure sensible retry/backoff and DLQ policies per service with visibility into failure reasons.
- Document routing keys and event types in shared/rabbitmq/topology.js and keep them synchronized across services.
- Add health checks and metrics for outbox worker throughput, queue lengths, and consumer lag.

## Where to edit next (PR-friendly checklist)

- Add or update a top-level docs file describing the event flow and routing keys for contributors.
- Add readiness/metrics endpoints for outbox worker and consumers, and wire them into the docker-compose health checks.
- Verify and enforce publisher confirms in the publishing path and add tests for outbox-to-RabbitMQ publish confirm behavior.

---

If you want, this can be moved to `docs/architecture.md` and expanded with diagrams and example event payloads for each step of the saga.