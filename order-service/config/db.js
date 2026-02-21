// Order Service Database Configuration
const { Pool } = require("pg");
const { parseNumber } = require("../../shared/utils/parseNumber");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseNumber(process.env.DB_PORT, 5433),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "password",
  database: process.env.DB_NAME || "order_db",
});

module.exports = {
  pool,
};
