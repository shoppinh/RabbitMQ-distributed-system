// shared/saga/sagaState.ts
import type { Pool } from "pg";

export const SagaStatus = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  REFUNDING: "refunding",
  TIMEOUT_CANCELLED: "timeout_cancelled",
} as const;

export type SagaStatusValue = (typeof SagaStatus)[keyof typeof SagaStatus];

export const SagaSteps = {
  STARTED: "started",
  PAYMENT_COMPLETED: "payment_completed",
  PAYMENT_FAILED: "payment_failed",
  INVENTORY_RESERVED: "inventory_reserved",
  INVENTORY_FAILED: "inventory_failed",
  PAYMENT_REFUND_REQUESTED: "payment_refund_requested",
  PAYMENT_REFUNDED: "payment_refunded",
  ORDER_CONFIRMED: "order_confirmed",
  ORDER_CANCELLED: "order_cancelled",
} as const;

export type SagaStepValue = (typeof SagaSteps)[keyof typeof SagaSteps];

export interface SagaInstance {
  saga_id: string;
  order_id: string;
  status: SagaStatusValue;
  current_step: SagaStepValue;
  timeout_at: Date;
  completed_at?: Date | null;
  failed_at?: Date | null;
  failure_reason?: string | null;
}

export class SagaStateManager {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async createSaga(
    sagaId: string,
    orderId: string,
    timeoutMs: number
  ): Promise<{ sagaId: string; orderId: string; status: SagaStatusValue }> {
    const client = await this.pool.connect();
    try {
      const timeoutAt = new Date(Date.now() + timeoutMs);

      await client.query(
        `INSERT INTO saga_instances 
         (saga_id, order_id, status, current_step, timeout_at) 
         VALUES ($1, $2, $3, $4, $5)`,
        [sagaId, orderId, SagaStatus.PENDING, SagaSteps.STARTED, timeoutAt]
      );

      return { sagaId, orderId, status: SagaStatus.PENDING };
    } finally {
      client.release();
    }
  }

  async getSaga(sagaId: string): Promise<SagaInstance | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<SagaInstance>(
        "SELECT * FROM saga_instances WHERE saga_id = $1",
        [sagaId]
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  async updateSagaStep(sagaId: string, step: SagaStepValue): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "UPDATE saga_instances SET current_step = $1 WHERE saga_id = $2",
        [step, sagaId]
      );
    } finally {
      client.release();
    }
  }

  async updateSagaStatus(
    sagaId: string,
    status: SagaStatusValue,
    failureReason?: string | null
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const updates: string[] = ["status = $1"];
      const values: unknown[] = [status, sagaId];
      let paramIndex = 3;

      if (status === SagaStatus.CONFIRMED) {
        updates.push(`completed_at = NOW()`);
      } else if (
        [SagaStatus.CANCELLED, SagaStatus.TIMEOUT_CANCELLED].includes(
          status as typeof SagaStatus.CANCELLED
        )
      ) {
        updates.push(`failed_at = NOW()`);
      }

      if (failureReason) {
        updates.push(`failure_reason = $${paramIndex}`);
        values.push(failureReason);
        paramIndex++;
      }

      const query = `
        UPDATE saga_instances 
        SET ${updates.join(", ")} 
        WHERE saga_id = $2
      `;

      await client.query(query, values);
    } finally {
      client.release();
    }
  }

  async findPendingTimeouts(): Promise<SagaInstance[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<SagaInstance>(
        `SELECT * FROM saga_instances 
         WHERE status = $1 AND timeout_at < NOW()`,
        [SagaStatus.PENDING]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async isPaymentCompleted(sagaId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT current_step FROM saga_instances 
         WHERE saga_id = $1 AND current_step = $2`,
        [sagaId, SagaSteps.PAYMENT_COMPLETED]
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }
}
