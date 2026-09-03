import 'dotenv/config';
import mysql from 'mysql2/promise';

import {
  ensureAgentFoundationSchema,
  verifyAgentFoundationSchema,
} from './agent/agent_schema.js';

const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  charset: 'utf8mb4',
});

try {
  await ensureAgentFoundationSchema(connection);
  console.log('agent_sessions and agent_action_audit are present (created if missing).');

  const verification = await verifyAgentFoundationSchema(connection);
  if (!verification.ok) {
    throw new Error(
      `Agent foundation schema verification failed:\n  - ${verification.problems.join('\n  - ')}`,
    );
  }

  console.log('Agent foundation schema verified (tables, columns, indexes, foreign keys).');
  console.log('Agent foundation migration completed successfully.');
} finally {
  await connection.end();
}