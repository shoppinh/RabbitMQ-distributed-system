// order-service/src/sagaHandler.ts
import type { PoolClient, Pool } from "pg";
import { writeEventToOutbox } from "../../shared/saga/outbox";
import { SagaStatus, SagaSteps, SagaStateManager, SagaStatusValue, SagaStepValue, SagaInstance } from "../../shared/saga/sagaState";
import { EventTypes } from "../../shared/rabbitmq/topology";
import type { Logger } from "../../shared/utils/logger";
import type { ConsumedEvent } from "../../shared/rabbitmq/consumerService";

export class SagaHandler {
  private pool: Pool;
  private sagaManager: SagaStateManager;
  private logger: Logger;

  constructor(pool: Pool, sagaStateManager: SagaStateManager, logger: Logger) {
    this.pool = pool;
    this.sagaManager = sagaStateManager;
    this.logger = logger;
  }

  async handleInventoryReserved(event: ConsumedEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if ((processed.rowCount ?? 0) > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      const sagaRes = await client.query<{ status: SagaStatusValue; current_step: SagaStepValue }>(
        "SELECT status, current_step FROM saga_instances WHERE saga_id = $1 FOR UPDATE",
        [event.sagaId]
      );
      const saga = sagaRes.rows[0];

      if (saga && saga.status !== SagaStatus.CANCELLED) {
        if (saga.current_step === SagaSteps.PAYMENT_COMPLETED) {
          await this.sagaManager.updateSagaStatus(event.sagaId, SagaStatus.CONFIRMED);
          await writeEventToOutbox(client, {
            type: EventTypes.ORDER_CONFIRMED,
            sagaId: event.sagaId,
            correlationId: event.correlationId,
            orderId: event.orderId,
            payload: {
              customerEmail: event.payload["customerEmail"],
              items: event.payload["items"],
              amount: event.payload["amount"],
              currency: event.payload["currency"],
            },
          });
          this.logger.info("Both Payment and Inventory done, order confirmed", {
            sagaId: event.sagaId,
          });
        } else {
          await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.INVENTORY_RESERVED);
          this.logger.info("Inventory reserved, waiting for payment", {
            sagaId: event.sagaId,
          });
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async handlePaymentCompleted(event: ConsumedEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if ((processed.rowCount ?? 0) > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      const sagaRes = await client.query<{ status: SagaStatusValue; current_step: SagaStepValue }>(
        "SELECT status, current_step FROM saga_instances WHERE saga_id = $1 FOR UPDATE",
        [event.sagaId]
      );
      const saga = sagaRes.rows[0];

      if (saga && saga.status !== SagaStatus.CANCELLED) {
        if (saga.current_step === SagaSteps.INVENTORY_RESERVED) {
          await this.sagaManager.updateSagaStatus(event.sagaId, SagaStatus.CONFIRMED);
          await writeEventToOutbox(client, {
            type: EventTypes.ORDER_CONFIRMED,
            sagaId: event.sagaId,
            correlationId: event.correlationId,
            orderId: event.orderId,
            payload: {
              customerEmail: event.payload["customerEmail"],
              items: event.payload["items"],
              amount: event.payload["amount"],
              currency: event.payload["currency"],
            },
          });
          this.logger.info("Both Payment and Inventory done, order confirmed", {
            sagaId: event.sagaId,
          });
        } else {
          await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.PAYMENT_COMPLETED);
          this.logger.info("Payment completed, waiting for inventory", {
            sagaId: event.sagaId,
          });
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureSagaCancelled(
    client: PoolClient,
    event: ConsumedEvent,
    reason: string,
    step: SagaStepValue
  ): Promise<void> {
    const sagaRes = await client.query<{ status: SagaStatusValue }>(
      "SELECT status FROM saga_instances WHERE saga_id = $1 FOR UPDATE",
      [event.sagaId]
    );
    if (
      (sagaRes.rowCount ?? 0) > 0 &&
      sagaRes.rows[0].status === SagaStatus.CANCELLED
    ) {
      return; // Already cancelled
    }

    await this.sagaManager.updateSagaStatus(event.sagaId, SagaStatus.CANCELLED, reason);
    await this.sagaManager.updateSagaStep(event.sagaId, step);

    await writeEventToOutbox(client, {
      type: EventTypes.ORDER_CANCELLED,
      sagaId: event.sagaId,
      correlationId: event.correlationId,
      orderId: event.orderId,
      payload: {
        reason,
        customerEmail: event.payload["customerEmail"],
      },
    });

    this.logger.info("Saga cancelled due to failure", {
      sagaId: event.sagaId,
      reason,
    });
  }

  async handlePaymentFailed(event: ConsumedEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if ((processed.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      await this.ensureSagaCancelled(client, event, "Payment failed", SagaSteps.PAYMENT_FAILED);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async handleInventoryFailed(event: ConsumedEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if ((processed.rowCount ?? 0) > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      await this.ensureSagaCancelled(
        client,
        event,
        "Inventory reservation failed",
        SagaSteps.INVENTORY_FAILED
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async handlePaymentRefunded(event: ConsumedEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if ((processed.rowCount ?? 0) > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.PAYMENT_REFUNDED);

      await client.query("COMMIT");
      this.logger.info("PaymentRefunded handled, compensation completed", {
        sagaId: event.sagaId,
        orderId: event.orderId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async handleTimeout(saga: SagaInstance): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const currentSaga = await this.sagaManager.getSaga(saga.saga_id);
      if (!currentSaga || currentSaga.status !== SagaStatus.PENDING) {
        this.logger.info("Saga no longer pending, skipping timeout", {
          sagaId: saga.saga_id,
        });
        await client.query("COMMIT");
        return;
      }

      await this.sagaManager.updateSagaStatus(
        saga.saga_id,
        SagaStatus.TIMEOUT_CANCELLED,
        "Saga timeout after 90 seconds"
      );

      await writeEventToOutbox(client, {
        type: EventTypes.ORDER_CANCELLED,
        sagaId: saga.saga_id,
        correlationId: saga.saga_id,
        orderId: saga.order_id,
        payload: {
          reason: "timeout",
          timeoutAfterMs: 90000,
        },
      });

      await client.query("COMMIT");
      this.logger.info("Saga timed out, order cancelled", {
        sagaId: saga.saga_id,
        orderId: saga.order_id,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
