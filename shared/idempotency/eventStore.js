class InMemoryEventStore {
  constructor(limit = 10000) {
    this.limit = limit;
    this.processedEventIds = new Set();
    this.insertionOrder = [];
  }

  has(eventId) {
    return this.processedEventIds.has(eventId);
  }

  add(eventId) {
    if (this.processedEventIds.has(eventId)) {
      return;
    }

    this.processedEventIds.add(eventId);
    this.insertionOrder.push(eventId);

    if (this.insertionOrder.length > this.limit) {
      const oldestEventId = this.insertionOrder.shift();
      this.processedEventIds.delete(oldestEventId);
    }
  }
}

module.exports = {
  InMemoryEventStore
};
