// payment-service/config/db.ts
import { Pool } from "pg";
import { parseNumber } from "../../shared/utils/parseNumber";

export const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseNumber(process.env.DB_PORT, 5434),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "password",
  database: process.env.DB_NAME || "payment_db",
});
