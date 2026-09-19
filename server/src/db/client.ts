import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

const client = postgres(config.DATABASE_URL, {
  max: config.NODE_ENV === "production" ? 10 : 3,
  prepare: false,
});

export const db = drizzle(client, { schema });
export const closeDatabase = () => client.end();
