const { pool } = require('../config/db');



class DatabaseEventStore {
  constructor(serviceName) {
    this.serviceName = serviceName;
  }

  /**
   * Try to mark an event as processed atomically.
   * @param {string} eventId - The event ID to mark as processed
   * @returns {Promise<boolean>} true if this is the first time processing (insert succeeded), false if already processed (conflict)
   */
  async tryAcquire(eventId) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'INSERT INTO processed_events (event_id, service_name) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
        [eventId, this.serviceName]
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
  DatabaseEventStore
};
