const { writeEventToOutbox, markEventAsProcessed } = require("../../shared/saga/outbox");
const { SagaStatus, SagaSteps } = require("../../shared/saga/sagaState");
const { EventTypes } = require("../../shared/rabbitmq/topology");

class SagaHandler {
  constructor(pool, sagaStateManager, logger) {
    this.pool = pool;
    this.sagaManager = sagaStateManager;
    this.logger = logger;
  }

  async handlePaymentCompleted(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Check if already processed
      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if (processed.rowCount > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      // Mark as processed
      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      // Update saga step
      await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.PAYMENT_COMPLETED);

      // No event to publish - wait for InventoryReserved
      
      await client.query("COMMIT");
      this.logger.info("PaymentCompleted handled, waiting for inventory", {
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

  async handlePaymentFailed(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if (processed.rowCount > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      // Update saga status
      await this.sagaManager.updateSagaStatus(
        event.sagaId,
        SagaStatus.CANCELLED,
        "Payment failed"
      );

      await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.PAYMENT_FAILED);

      // Write OrderCancelled to outbox
      await writeEventToOutbox(client, {
        type: EventTypes.ORDER_CANCELLED,
        sagaId: event.sagaId,
        correlationId: event.correlationId,
        orderId: event.orderId,
        payload: {
          reason: "payment_failed",
          customerEmail: event.payload.customerEmail,
        },
      });

      await client.query("COMMIT");
      this.logger.info("PaymentFailed handled, order cancelled", {
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

  async handleInventoryReserved(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if (processed.rowCount > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      // Update saga status to confirmed
      await this.sagaManager.updateSagaStatus(event.sagaId, SagaStatus.CONFIRMED);
      await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.INVENTORY_RESERVED);

      // Write OrderConfirmed to outbox
      await writeEventToOutbox(client, {
        type: EventTypes.ORDER_CONFIRMED,
        sagaId: event.sagaId,
        correlationId: event.correlationId,
        orderId: event.orderId,
        payload: {
          customerEmail: event.payload.customerEmail,
          items: event.payload.items,
          amount: event.payload.amount,
          currency: event.payload.currency,
        },
      });

      await client.query("COMMIT");
      this.logger.info("InventoryReserved handled, order confirmed", {
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

  async handleInventoryFailed(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if (processed.rowCount > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      // Update saga status to refunding
      await this.sagaManager.updateSagaStatus(event.sagaId, SagaStatus.REFUNDING);
      await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.INVENTORY_FAILED);

      // Write PaymentRefundRequested to outbox
      await writeEventToOutbox(client, {
        type: EventTypes.PAYMENT_REFUND_REQUESTED,
        sagaId: event.sagaId,
        correlationId: event.correlationId,
        orderId: event.orderId,
        payload: {
          amount: event.payload.amount,
          currency: event.payload.currency,
          reason: "inventory_reservation_failed",
        },
      });

      await client.query("COMMIT");
      this.logger.info("InventoryFailed handled, refund requested", {
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

  async handlePaymentRefunded(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const processed = await client.query(
        "SELECT 1 FROM processed_events WHERE event_id = $1",
        [event.eventId]
      );
      if (processed.rowCount > 0) {
        this.logger.warn("Duplicate event, skipping", { eventId: event.eventId });
        await client.query("COMMIT");
        return;
      }

      await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1)",
        [event.eventId]
      );

      // Update saga status to cancelled
      await this.sagaManager.updateSagaStatus(
        event.sagaId,
        SagaStatus.CANCELLED,
        "Payment refunded after inventory failure"
      );
      await this.sagaManager.updateSagaStep(event.sagaId, SagaSteps.PAYMENT_REFUNDED);

      // Write OrderCancelled to outbox
      await writeEventToOutbox(client, {
        type: EventTypes.ORDER_CANCELLED,
        sagaId: event.sagaId,
        correlationId: event.correlationId,
        orderId: event.orderId,
        payload: {
          reason: "compensation",
          refundAmount: event.payload.amount,
          customerEmail: event.payload.customerEmail,
        },
      });

      await client.query("COMMIT");
      this.logger.info("PaymentRefunded handled, order cancelled with refund", {
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

  async handleTimeout(saga) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Check if saga is still pending
      const currentSaga = await this.sagaManager.getSaga(saga.saga_id);
      if (!currentSaga || currentSaga.status !== SagaStatus.PENDING) {
        this.logger.info("Saga no longer pending, skipping timeout", {
          sagaId: saga.saga_id,
        });
        await client.query("COMMIT");
        return;
      }

      // Update saga status to timeout_cancelled
      await this.sagaManager.updateSagaStatus(
        saga.saga_id,
        SagaStatus.TIMEOUT_CANCELLED,
        "Saga timeout after 90 seconds"
      );

      // Write OrderCancelled to outbox
      await writeEventToOutbox(client, {
        type: EventTypes.ORDER_CANCELLED,
        sagaId: saga.saga_id,
        // Timeout is a system-triggered branch; use saga_id for trace continuity.
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

module.exports = {
  SagaHandler,
};
