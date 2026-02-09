const { Pool } = require("pg");
const { getDatabaseConfig } = require("./env");
const pool = new Pool(getDatabaseConfig());

module.exports = {
  pool,
};
