function createLogger(serviceName) {
  function log(level, message, meta) {
    const base = {
      timestamp: new Date().toISOString(),
      service: serviceName,
      level,
      message
    };

    if (meta) {
      console.log(JSON.stringify({ ...base, ...meta }));
      return;
    }

    console.log(JSON.stringify(base));
  }

  return {
    info: (message, meta) => log('INFO', message, meta),
    warn: (message, meta) => log('WARN', message, meta),
    error: (message, meta) => log('ERROR', message, meta),
    debug: (message, meta) => log('DEBUG', message, meta)
  };
}

module.exports = {
  createLogger
};
