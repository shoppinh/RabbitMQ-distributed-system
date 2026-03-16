// shared/idempotency/eventStore.ts
import type { Pool } from "pg";

export interface IEventStore {
  tryAcquire(eventId: string): Promise<boolean>;
}

export class DatabaseEventStore implements IEventStore {
  private serviceName: string;
  private pool: Pool;

  constructor(serviceName: string, pool: Pool) {
    this.serviceName = serviceName;
    this.pool = pool;
  }

  /**
   * Try to mark an event as processed atomically.
   * @returns true if this is the first time processing (insert succeeded),
   *          false if already processed (conflict).
   */
  async tryAcquire(eventId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING",
        [eventId]
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }
}
