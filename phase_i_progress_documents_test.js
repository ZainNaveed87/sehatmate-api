/**
 * Phase I Progress + Documents tests (no HTTP server, no real DB, no LLM).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  deleteDocument,
  listDocuments,
  readDocumentFile,
} from './services/document_service.js';
import {
  readProgressSummary,
} from './services/performance_summary_service.js';
import {
  teachBackSourceVersion,
} from './services/teach_back_service.js';

const USER = '42';
const OTHER_USER = '99';
const TODAY = '2026-09-03';
const OK_PACKET = { affectedRows: 1, insertId: 0 };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function createFakePool(respond) {
  const calls = [];
  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });
    const custom = respond ? respond(text, params) : undefined;
    if (custom !== undefined) return custom;
    return /^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text) ? [[]] : [OK_PACKET];
  };
  return {
    execute,
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
    calls,
  };
}

function occurrenceRows() {
  return [
    {
      occurrence_date: '2026-08-28',
      status: 'completed',
      scheduled_at: new Date('2026-08-28T08:00:00Z'),
      completed_at: new Date('2026-08-28T08:10:00Z'),
    },
    {
      occurrence_date: '2026-08-29',
      status: 'skipped',
      scheduled_at: new Date('2026-08-29T08:00:00Z'),
      completed_at: null,
    },
    {
      occurrence_date: '2026-08-30',
      status: 'missed',
      scheduled_at: new Date('2026-08-30T08:00:00Z'),
      completed_at: null,
    },
    {
      occurrence_date: '2026-09-01',
      status: 'pending',
      scheduled_at: new Date('2026-09-01T08:00:00Z'),
      completed_at: null,
    },
    {
      occurrence_date: '2026-09-03',
      status: 'completed',
      scheduled_at: new Date('2026-09-03T08:00:00Z'),
      completed_at: new Date('2026-09-03T08:05:00Z'),
    },
  ];
}

function instruction() {
  return {
    id: '10',
    care_plan_id: '3',
    title: 'DemoMed',
    instruction: 'Take one tablet daily.',
    timing: 'Morning',
    verified_at: '2026-09-01 08:00:00',
    plan_title: 'Recovery',
    plan_updated_at: '2026-09-01 09:00:00',
  };
}

function attemptFor(sourceVersion, overrides = {}) {
  return {
    id: overrides.id || '1',
    user_id: USER,
    care_plan_id: '3',
    target_type: 'instruction',
    target_id: '10',
    question_id: overrides.question_id || 'what_to_do',
    question_text: 'Question',
    answer_text: 'Answer',
    assessment_status: overrides.assessment_status || 'understood',
    score: overrides.score ?? 90,
    matched_points_json: '[]',
    missing_points_json: '[]',
    feedback: 'Understood.',
    retry_prompt: null,
    source_title: 'DemoMed',
    source_updated_at: '2026-09-01 08:00:00',
    source_version: sourceVersion,
    created_at: overrides.created_at || '2026-09-01 10:00:00',
  };
}

function progressPool({
  activePlans = [{ id: 3, title: 'Recovery', readiness_score: 84 }],
  rows = occurrenceRows(),
  gaps = [
    { lifecycle_status: 'open', severity: 'blocking' },
    { lifecycle_status: 'in_progress', severity: 'attention' },
    { lifecycle_status: 'resolved', severity: 'attention' },
  ],
  instructions = [instruction()],
  attempts = null,
} = {}) {
  const currentSourceVersion = teachBackSourceVersion({
    targetType: 'instruction',
    targetId: '10',
    carePlanId: '3',
    title: 'DemoMed',
    instruction: 'Take one tablet daily.',
    timing: 'Morning',
    notes: '',
  });
  const storedAttempts = attempts ?? [
    attemptFor(currentSourceVersion, { question_id: 'what_to_do', score: 90 }),
    attemptFor(currentSourceVersion, { question_id: 'when_to_do_it', score: 80 }),
    attemptFor(currentSourceVersion, { question_id: 'important_instruction', score: 100 }),
  ];

  return createFakePool((text, params) => {
    if (text.includes('SELECT id, title, readiness_score FROM care_plans')) {
      return [activePlans];
    }
    if (text.startsWith('SELECT id, title FROM care_plans WHERE user_id')) {
      return [activePlans.map(({ id, title }) => ({ id, title }))];
    }
    if (text.startsWith('SELECT id, title FROM care_plans WHERE id = ?')) {
      const plan = activePlans.find((item) => String(item.id) === String(params[0]));
      return [plan ? [{ id: plan.id, title: plan.title }] : []];
    }
    if (text.startsWith('SELECT id FROM care_plans WHERE id = ?')) {
      const plan = activePlans.find((item) => String(item.id) === String(params[0]));
      return [plan ? [{ id: plan.id }] : []];
    }
    if (text.includes('COUNT(*) AS open_count')) {
      return [[{ open_count: gaps.filter((item) => item.lifecycle_status !== 'resolved').length }]];
    }
    if (text.includes('occurrence_date BETWEEN')) {
      return [rows];
    }
    if (text.includes('FROM care_task_occurrences') && text.includes('JOIN care_schedule_items')) {
      return [[]];
    }
    if (text.includes('FROM care_gaps g JOIN care_plans p')) {
      return [gaps];
    }
    if (text.includes('FROM extracted_instructions i JOIN care_plans p') &&
      text.includes('WHERE i.care_plan_id = ?')) {
      return [instructions];
    }
    if (text.includes('FROM care_schedule_items s JOIN care_plans p') &&
      text.includes('WHERE s.care_plan_id = ?')) {
      return [[]];
    }
    if (text.includes('FROM teach_back_attempts')) {
      const ids = params.slice(6);
      return [
        storedAttempts.filter((item) =>
          String(item.user_id) === String(params[0]) &&
          String(item.care_plan_id) === String(params[1]) &&
          item.target_type === params[2] &&
          String(item.target_id) === String(params[3]) &&
          item.source_version === params[4] &&
          String(item.source_updated_at) === String(params[5]) &&
          ids.includes(item.question_id)),
      ];
    }
    return undefined;
  });
}

await test('progress route is authenticated', async () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/api\/progress\/summary', authenticate,/);
});

await test('progress route uses req.auth.userId only', async () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const route = source.slice(
    source.indexOf("app.get('/api/progress/summary'"),
    source.indexOf("app.get('/api/care-plans/:id/task-occurrences'"),
  );
  assert.match(route, /userId: req\.auth\.userId/);
  assert.doesNotMatch(route, /userId: req\.(body|query|params)/);
});

await test('progress rejects invalid window with stable error', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 'nope',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROGRESS_INVALID_WINDOW');
});

await test('progress clamps days to the 1..31 window', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: '40',
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.windowDays, 31);
});

await test('progress excludes foreign data by binding authenticated user in every user-owned query', async () => {
  const pool = progressPool();
  await readProgressSummary({ pool, userId: USER, today: TODAY, days: 7 });
  const userOwnedCalls = pool.calls.filter((call) =>
    call.sql.includes('user_id') || call.sql.includes('p.user_id'));
  assert.ok(userOwnedCalls.length > 0);
  assert.ok(userOwnedCalls.every((call) => call.params.includes(USER)));
  assert.ok(userOwnedCalls.every((call) => !call.params.includes(OTHER_USER)));
});

await test('progress task counts are real occurrence counts', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.deepEqual(result.data.tasks, {
    scheduled: 5,
    completed: 2,
    skipped: 1,
    missed: 1,
    pending: 1,
    completionRate: 40,
  });
});

await test('progress completion rate is completed divided by scheduled', async () => {
  const result = await readProgressSummary({
    pool: progressPool({
      rows: occurrenceRows().slice(0, 4),
    }),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.equal(result.data.tasks.completionRate, 25);
});

await test('progress zero scheduled reports null completion, never fake zero', async () => {
  const result = await readProgressSummary({
    pool: progressPool({ rows: [] }),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.equal(result.data.tasks.scheduled, 0);
  assert.equal(result.data.tasks.completionRate, null);
});

await test('progress trend returns one daily row per window day', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.equal(result.data.trend.metric, 'task_completion_rate');
  assert.equal(result.data.trend.points.length, 7);
  assert.deepEqual(result.data.trend.points[0], {
    date: '2026-08-28',
    scheduled: 1,
    completed: 1,
    value: 100,
  });
});

await test('progress trend has no fake readiness history', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.equal(result.data.trend.metric, 'task_completion_rate');
  assert.ok(result.data.trend.points.every((point) => !Object.hasOwn(point, 'readiness')));
});

await test('progress trend no-data days keep null values', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  const emptyDay = result.data.trend.points.find((point) => point.date === '2026-08-31');
  assert.equal(emptyDay.scheduled, 0);
  assert.equal(emptyDay.value, null);
});

await test('progress reports no active plan readiness unavailable', async () => {
  const result = await readProgressSummary({
    pool: progressPool({ activePlans: [], gaps: [], instructions: [], attempts: [] }),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.equal(result.data.activePlanCount, 0);
  assert.equal(result.data.primaryPlan, null);
  assert.deepEqual(result.data.readiness, { available: false, score: null });
});

await test('progress gap aggregation uses authoritative lifecycle states', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.deepEqual(result.data.gaps, {
    total: 3,
    open: 2,
    inProgress: 1,
    resolved: 1,
  });
});

await test('progress current Teach Back understanding is used', async () => {
  const result = await readProgressSummary({
    pool: progressPool(),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.deepEqual(result.data.understanding, {
    available: true,
    score: 90,
    planId: '3',
    planTitle: 'Recovery',
  });
});

await test('progress ignores stale Teach Back source versions', async () => {
  const result = await readProgressSummary({
    pool: progressPool({
      attempts: [
        attemptFor('v1:stale', { question_id: 'what_to_do', score: 100 }),
        attemptFor('v1:stale', { question_id: 'when_to_do_it', score: 100 }),
        attemptFor('v1:stale', { question_id: 'important_instruction', score: 100 }),
      ],
    }),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.equal(result.data.understanding.available, false);
  assert.equal(result.data.understanding.score, null);
});

await test('progress no current Teach Back reports unavailable', async () => {
  const result = await readProgressSummary({
    pool: progressPool({ attempts: [] }),
    userId: USER,
    today: TODAY,
    days: 7,
  });
  assert.deepEqual(result.data.understanding, {
    available: false,
    score: null,
    planId: '3',
    planTitle: 'Recovery',
  });
});

await test('progress performs zero LLM or provider calls', async () => {
  const pool = progressPool();
  await readProgressSummary({ pool, userId: USER, today: TODAY, days: 7 });
  assert.ok(pool.calls.every((call) => !/generateAgentReply|ai_usage|agent_provider/i.test(call.sql)));
});

await test('document list route is authenticated', async () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/api\/documents', authenticate,/);
});

await test('document list metadata is user scoped', async () => {
  const pool = createFakePool(() => [[{
    id: 7,
    care_plan_id: 3,
    care_plan_title: 'Recovery',
    document_type: 'prescription',
    original_name: 'rx.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 1200,
    page_count: 2,
    processing_status: 'processed',
    processing_error: null,
    created_at: '2026-09-01 10:00:00',
    instruction_count: 4,
    verified_instruction_count: 3,
  }]]);
  const result = await listDocuments({ pool, userId: USER });
  assert.equal(result.ok, true);
  assert.deepEqual(pool.calls[0].params, [USER, USER]);
  assert.equal(result.data.documents.length, 1);
});

await test('document list joins same-user care plan metadata', async () => {
  const pool = createFakePool(() => [[{
    id: 7,
    care_plan_id: 3,
    care_plan_title: 'Recovery Plan',
    document_type: 'prescription',
    original_name: 'rx.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 1200,
    page_count: 2,
    processing_status: 'processed',
    processing_error: null,
    created_at: '2026-09-01 10:00:00',
    instruction_count: 4,
    verified_instruction_count: 3,
  }]]);
  const result = await listDocuments({ pool, userId: USER });
  assert.equal(result.data.documents[0].carePlanTitle, 'Recovery Plan');
  assert.match(pool.calls[0].sql, /JOIN care_plans p ON p.id = d.care_plan_id/);
  assert.match(pool.calls[0].sql, /p.user_id = \?/);
});

await test('document metadata never exposes blob or storage fields', async () => {
  const pool = createFakePool(() => [[{
    id: 7,
    care_plan_id: 3,
    care_plan_title: 'Recovery',
    document_type: 'prescription',
    original_name: 'rx.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 1200,
    page_count: 2,
    processing_status: 'processed',
    processing_error: null,
    created_at: '2026-09-01 10:00:00',
    instruction_count: 4,
    verified_instruction_count: 3,
    file_data: Buffer.from('secret'),
    storage_path: 'mysql://care_documents/secret.pdf',
    stored_name: 'secret.pdf',
    file_sha256: 'abc',
  }]]);
  const result = await listDocuments({ pool, userId: USER });
  const document = result.data.documents[0];
  assert.ok(!Object.hasOwn(document, 'file_data'));
  assert.ok(!Object.hasOwn(document, 'fileData'));
  assert.ok(!Object.hasOwn(document, 'storage_path'));
  assert.ok(!Object.hasOwn(document, 'storagePath'));
  assert.ok(!Object.hasOwn(document, 'stored_name'));
  assert.ok(!Object.hasOwn(document, 'file_sha256'));
});

await test('document list exposes instruction and verified counts', async () => {
  const pool = createFakePool(() => [[{
    id: 7,
    care_plan_id: 3,
    care_plan_title: 'Recovery',
    document_type: 'prescription',
    original_name: 'rx.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 1200,
    page_count: 2,
    processing_status: 'processed',
    processing_error: null,
    created_at: '2026-09-01 10:00:00',
    instruction_count: 4,
    verified_instruction_count: 3,
  }]]);
  const result = await listDocuments({ pool, userId: USER });
  assert.equal(result.data.documents[0].instructionCount, 4);
  assert.equal(result.data.documents[0].verifiedInstructionCount, 3);
});

await test('document list sorts newest first', async () => {
  const pool = createFakePool();
  await listDocuments({ pool, userId: USER });
  assert.match(pool.calls[0].sql, /ORDER BY d.created_at DESC, d.id DESC/);
});

await test('document list preserves null page_count', async () => {
  const pool = createFakePool(() => [[{
    id: 7,
    care_plan_id: 3,
    care_plan_title: 'Recovery',
    document_type: 'prescription',
    original_name: 'rx.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 1200,
    page_count: null,
    processing_status: 'processed',
    processing_error: null,
    created_at: '2026-09-01 10:00:00',
    instruction_count: 0,
    verified_instruction_count: 0,
  }]]);
  const result = await listDocuments({ pool, userId: USER });
  assert.equal(result.data.documents[0].pageCount, null);
});

await test('document file invalid id returns stable code', async () => {
  const result = await readDocumentFile({
    pool: createFakePool(),
    userId: USER,
    documentId: 'abc',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_DOCUMENT_ID');
});

await test('foreign document file access fails', async () => {
  const result = await readDocumentFile({
    pool: createFakePool(() => [[]]),
    userId: USER,
    documentId: '7',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DOCUMENT_NOT_FOUND');
});

await test('own document file returns exact bytes and content type', async () => {
  const bytes = Buffer.from('%PDF-1.4');
  const result = await readDocumentFile({
    pool: createFakePool(() => [[{
      id: 7,
      original_name: 'rx.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: bytes.length,
      file_data: bytes,
    }]]),
    userId: USER,
    documentId: '7',
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.document.mimeType, 'application/pdf');
  assert.equal(Buffer.compare(result.data.document.fileData, bytes), 0);
});

await test('foreign document delete fails', async () => {
  const result = await deleteDocument({
    pool: createFakePool(() => [[]]),
    userId: USER,
    documentId: '7',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DOCUMENT_NOT_FOUND');
});

await test('own document delete follows existing behavior', async () => {
  const pool = createFakePool((text) => {
    if (text.startsWith('SELECT id, care_plan_id FROM care_documents')) {
      return [[{ id: 7, care_plan_id: 3 }]];
    }
    if (text.includes('COUNT(*) AS document_count')) {
      return [[{ document_count: 0 }]];
    }
    return undefined;
  });
  const result = await deleteDocument({ pool, userId: USER, documentId: '7' });
  assert.equal(result.ok, true);
  assert.equal(result.data.carePlanId, '3');
  assert.ok(pool.calls.some((call) => call.sql.startsWith('DELETE FROM care_documents')));
  assert.ok(pool.calls.some((call) => call.sql.startsWith('UPDATE care_plans SET status =')));
});

await test('client-supplied user identity is never trusted by Phase I services', async () => {
  const pool = progressPool();
  await readProgressSummary({
    pool,
    userId: USER,
    today: TODAY,
    days: 7,
    clientUserId: OTHER_USER,
  });
  assert.ok(pool.calls.every((call) => !call.params.includes(OTHER_USER)));
});

console.log(`Phase I progress/documents tests passed (${passed} tests).`);
