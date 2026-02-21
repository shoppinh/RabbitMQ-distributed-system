class DatabaseEventStore {
  constructor(serviceName, pool = null) {
    this.serviceName = serviceName;
    this.pool = pool;
  }

  /**
   * Try to mark an event as processed atomically.
   * @param {string} eventId - The event ID to mark as processed
   * @returns {Promise<boolean>} true if this is the first time processing (insert succeeded), false if already processed (conflict)
   */
  async tryAcquire(eventId) {
    const poolToUse = this.pool;
    if (!poolToUse) {
      throw new Error("Pool not provided to DatabaseEventStore");
    }
    
    const client = await poolToUse.connect();
    try {
      const result = await client.query(
        "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING",
        [eventId],
      );
      // If rowCount > 0, the insert succeeded (first time seeing this event)
      // If rowCount = 0, conflict occurred (duplicate event)
      return result.rowCount > 0;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  DatabaseEventStore,
};
