import 'dotenv/config';
import mysql from 'mysql2/promise';

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

async function columnExists(table, column) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function indexExists(table, indexName) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName],
  );
  return rows.length > 0;
}

async function addColumn(name, ddl) {
  if (await columnExists('care_gaps', name)) {
    console.log(`care_gaps.${name} already exists`);
    return false;
  }
  await connection.query(`ALTER TABLE care_gaps ADD COLUMN ${ddl}`);
  console.log(`Added care_gaps.${name}`);
  return true;
}

try {
  await addColumn('gap_type', "gap_type VARCHAR(40) NULL AFTER category");
  const severityAdded = await addColumn(
    'severity',
    "severity ENUM('blocking','attention') NOT NULL DEFAULT 'attention' AFTER status",
  );
  const lifecycleAdded = await addColumn(
    'lifecycle_status',
    "lifecycle_status ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open' AFTER severity",
  );
  await addColumn('source_key', "source_key VARCHAR(160) NULL AFTER resolved_at");
  await addColumn('source_kind', "source_kind VARCHAR(40) NULL AFTER source_key");
  await addColumn('source_id', "source_id VARCHAR(191) NULL AFTER source_kind");
  await addColumn('due_at', "due_at DATETIME NULL AFTER source_id");
  await addColumn('auto_managed', "auto_managed TINYINT(1) NOT NULL DEFAULT 0 AFTER due_at");

  if (lifecycleAdded) {
    await connection.query(
      `UPDATE care_gaps
       SET lifecycle_status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE 'open' END`,
    );
  }
  if (severityAdded) {
    await connection.query(
      `UPDATE care_gaps
       SET severity = CASE
         WHEN status IN ('blocked', 'unclear') THEN 'blocking'
         ELSE 'attention'
       END`,
    );
  }

  if (!(await indexExists('care_gaps', 'care_gaps_source_unique'))) {
    await connection.query(
      `ALTER TABLE care_gaps
       ADD UNIQUE KEY care_gaps_source_unique (care_plan_id, source_key)`,
    );
    console.log('Added care_gaps_source_unique');
  }
  if (!(await indexExists('care_gaps', 'care_gaps_severity_lifecycle_idx'))) {
    await connection.query(
      `ALTER TABLE care_gaps
       ADD KEY care_gaps_severity_lifecycle_idx (care_plan_id, severity, lifecycle_status)`,
    );
    console.log('Added care_gaps_severity_lifecycle_idx');
  }

  console.log('Care Gap migration completed successfully.');
} finally {
  await connection.end();
}
