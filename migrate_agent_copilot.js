// Operator-run only. No migration runs during server startup or tests.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { ensureAgentCopilotSchema } from './agent/agent_copilot_schema.js';

const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter(key => !process.env[key]?.trim());
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, charset: 'utf8mb4' });
try {
  const result = await ensureAgentCopilotSchema(connection);
  if (!result.ok) throw new Error(`Agent Copilot schema verification failed:\n${result.problems.join('\n')}`);
  console.log('Agent Copilot schema created if missing and verified.');
} finally { await connection.end(); }
