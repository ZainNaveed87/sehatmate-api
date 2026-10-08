import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotTestDb } from './agent_copilot_test_db.js';
import { createAgentMemory, supersedeAgentMemory, confirmAgentMemory, deactivateAgentMemory, readRelevantAgentMemory, validateAgentMemoryProposal, rememberVerifiedAgentPatterns } from './agent/agent_memory.js';
import { saveCopilotContext, readCopilotContext, saveCopilotPlan, recordCopilotReceipt } from './agent/agent_copilot_store.js';
import { detectAgentConflicts, conflictsFromToolResults, AGENT_CONFLICT_RESOLUTIONS } from './agent/agent_conflicts.js';
import { mountAgentCopilotRoutes } from './agent/agent_copilot_routes.js';
import { AGENT_COPILOT_DDL, ensureAgentCopilotSchema, verifyAgentCopilotSchema } from './agent/agent_copilot_schema.js';

const memory = await import('./agent/agent_memory.js').catch(() => null);
test('Phase 2 structured memory service is available', () => {
  assert.equal(typeof memory?.createAgentMemory, 'function');
});
const preference = (overrides = {}) => ({ kind: 'USER_PREFERENCE', key: 'communication.language', value: { language: 'roman_ur' }, source: 'user_api', evidenceRef: 'turn:1', confirmedByUser: true, ...overrides });
const create = (db, item = preference(), userId = '1') => createAgentMemory({ db, userId, item, evidence: { explicitUser: true, ref: item.evidenceRef } });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);
test('confirmed fact records explicit evidence and no clinical keys', async () => {
  const db = new CopilotTestDb();
  const result = await create(db, preference({ kind: 'CONFIRMED_FACT', key: 'availability.constraint', value: { days: [1, 2], startMinute: 480, endMinute: 540, available: false } }));
  assert.equal(result.memory.kind, 'CONFIRMED_FACT'); assert.equal(db.memory[0].confirmed_by_user, 1);
  await rejectsCode(create(db, preference({ key: 'diagnosis', value: { text: 'diabetes' } })), 'INVALID_AGENT_MEMORY');
});
test('model speculation and unconfirmed preferences never persist', async () => {
  const db = new CopilotTestDb();
  await rejectsCode(create(db, preference({ source: 'model' })), 'AGENT_MEMORY_CONFIRMATION_REQUIRED');
  await rejectsCode(create(db, preference({ confirmedByUser: false })), 'AGENT_MEMORY_CONFIRMATION_REQUIRED');
  await rejectsCode(createAgentMemory({ db, userId: '1', item: preference() }), 'AGENT_MEMORY_CONFIRMATION_REQUIRED');
  assert.equal(db.memory.length, 0);
});
test('inferences require verified referenced events and expiry, remain separate', async () => {
  const db = new CopilotTestDb();
  const item = preference({ kind: 'INFERRED_PATTERN', key: 'routine.missed_pattern', value: { periodDays: 7, missedCount: 5, timeOfDay: 'morning' }, source: 'verified_event', confirmedByUser: false, confidence: 0.8, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  await rejectsCode(createAgentMemory({ db, userId: '1', item, evidence: { verified: false, ref: item.evidenceRef } }), 'AGENT_MEMORY_VERIFIED_EVIDENCE_REQUIRED');
  const result = await createAgentMemory({ db, userId: '1', item, evidence: { verified: true, ref: item.evidenceRef } });
  assert.equal(result.memory.kind, 'INFERRED_PATTERN'); assert.equal(result.memory.confirmedByUser, false);
  assert.equal(db.memory[0].confirmed_by_user, 0);
});
test('correction supersedes one active same-key class and keeps audit history', async () => {
  const db = new CopilotTestDb(); const first = await create(db);
  const second = await supersedeAgentMemory({ db, userId: '1', supersedesId: first.memory.id, item: preference({ value: { language: 'en' } }), evidence: { explicitUser: true, ref: 'turn:1' } });
  assert.equal(db.memory.length, 2); assert.equal(db.memory[0].status, 'superseded'); assert.equal(db.memory[0].superseded_by, second.memory.id);
  const relevant = await readRelevantAgentMemory({ db, userId: '1', screenId: 'profile' });
  assert.deepEqual(relevant.map(m => m.value), [{ language: 'en' }]);
});
test('foreign-user correction and deactivation are isolated', async () => {
  const db = new CopilotTestDb(); const first = await create(db);
  await rejectsCode(supersedeAgentMemory({ db, userId: '2', supersedesId: first.memory.id, item: preference(), evidence: { explicitUser: true, ref: 'turn:1' } }), 'AGENT_MEMORY_NOT_FOUND');
  await rejectsCode(deactivateAgentMemory({ db, userId: '2', memoryId: first.memory.id }), 'AGENT_MEMORY_NOT_FOUND');
  assert.deepEqual(await readRelevantAgentMemory({ db, userId: '2', screenId: 'profile' }), []);
  assert.equal(db.memory[0].status, 'active');
});
test('explicit confirmation supersedes inferred record into confirmed class', async () => {
  const db = new CopilotTestDb(); const item = preference({ kind: 'INFERRED_PATTERN', source: 'verified_event', confirmedByUser: false, confidence: 0.7, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const result = await createAgentMemory({ db, userId: '1', item, evidence: { verified: true, ref: item.evidenceRef } });
  const confirmed = await confirmAgentMemory({ db, userId: '1', memoryId: result.memory.id, evidenceRef: 'confirm:1' });
  assert.equal(confirmed.memory.kind, 'CONFIRMED_FACT'); assert.equal(confirmed.memory.confirmedByUser, true);
  assert.equal(db.memory[0].status, 'superseded');
});
test('deactivation removes a memory from relevant reads', async () => {
  const db = new CopilotTestDb(); const result = await create(db);
  await deactivateAgentMemory({ db, userId: '1', memoryId: result.memory.id });
  assert.deepEqual(await readRelevantAgentMemory({ db, userId: '1', screenId: 'profile' }), []);
});
test('screen retrieval excludes unrelated memory and supports canonical screen aliases', async () => {
  const db = new CopilotTestDb(); await create(db); await create(db, preference({ key: 'availability.constraint', value: { days: [1], startMinute: 480, endMinute: 540, available: false } }));
  assert.equal((await readRelevantAgentMemory({ db, userId: '1', screenId: 'documents' })).length, 1);
  assert.equal((await readRelevantAgentMemory({ db, userId: '1', screenId: 'care_plan_detail' })).length, 2);
  assert.equal((await readRelevantAgentMemory({ db, userId: '1', screenId: 'care_plan_detail', keys: ['availability.constraint'] })).length, 1);
});
test('retrieval is bounded and excludes expired rows and malformed JSON', async () => {
  const db = new CopilotTestDb(); await create(db);
  db.memory.push({ ...db.memory[0], id: '2', value_json: '{invalid' });
  db.memory.push({ ...db.memory[0], id: '3', expires_at: new Date(Date.now() - 1000) });
  assert.equal((await readRelevantAgentMemory({ db, userId: '1', screenId: 'profile', limit: 99 })).length, 1);
  assert.match(db.calls.findLast(c=>c.sql.startsWith('SELECT * FROM agent_memory')).sql, /LIMIT 12$/);
});
test('planner retrieval records scoped use while memory review does not',async()=>{
  const db=new CopilotTestDb();await create(db);await create(db,preference(),'2');
  await readRelevantAgentMemory({db,userId:'1',screenId:'profile',review:true});
  assert.equal(db.memory[0].last_used_at,undefined);
  const items=await readRelevantAgentMemory({db,userId:'1',screenId:'profile'});
  assert.ok(db.memory[0].last_used_at);assert.equal(db.memory[1].last_used_at,undefined);assert.ok(items[0].lastUsedAt);
});
test('real multi-day verified performance can persist one bounded inferred pattern without confirmation',async()=>{
  const db=new CopilotTestDb();
  const tool={name:'get_performance_summary',result:{ok:true,data:{periods:{current:{startDate:'2026-10-01',endDate:'2026-10-07',days:7,summary:{missed:5}}}}}};
  await rememberVerifiedAgentPatterns({db,userId:'1',toolResults:[tool]});
  assert.equal(db.memory.length,1);assert.equal(db.memory[0].kind,'INFERRED_PATTERN');assert.equal(db.memory[0].confirmed_by_user,0);
  assert.deepEqual(JSON.parse(db.memory[0].value_json),{periodDays:7,missedCount:5,timeOfDay:'any'});
  await rememberVerifiedAgentPatterns({db,userId:'1',toolResults:[tool]});assert.equal(db.memory.length,1);
  await rememberVerifiedAgentPatterns({db,userId:'2',toolResults:[{...tool,result:{ok:false,data:tool.result.data}}]});
  await rememberVerifiedAgentPatterns({db,userId:'2',toolResults:[{name:'client_ui',result:tool.result}]});
  assert.equal(db.memory.length,1);
});
test('memory proposal permits only closed nonclinical explicit schemas', () => {
  assert.equal(validateAgentMemoryProposal({ kind: 'USER_PREFERENCE', key: 'communication.language', value: { language: 'ur' } }).ok, true);
  assert.equal(validateAgentMemoryProposal({kind:'USER_PREFERENCE',key:'constructor',value:{}}).ok,false);
  for (const bad of [{ kind: 'INFERRED_PATTERN', key: 'communication.language', value: { language: 'ur' } }, { kind: 'USER_PREFERENCE', key: 'medication.dose', value: { amount: 10 } }, { kind: 'USER_PREFERENCE', key: 'communication.language', value: { language: 'ur', rawTranscript: 'secret' } }, { kind: 'USER_PREFERENCE', key: 'communication.language', value: { language: 'ur' }, confidence: 1 }]) assert.equal(validateAgentMemoryProposal(bad).ok, false);
});
const context = { screenId: 'reality_check', ui: { screenId: 'reality_check', version: 'v1' } };
const plan = { id: 'plan-1', screenId: 'reality_check', version: 'v1', operations: [{ actionId: 'highlight', targetId: 'reality_check.question.current', args: {} }] };
const receipt = { userId: '1', sessionId: '11', planId: plan.id, actionId: 'highlight', targetId: 'reality_check.question.current', status: 'succeeded', source: 'text', screenVersionBefore: 'v1', screenVersionAfter: 'v1' };
test('compact expiring context is isolated to an owned active session', async () => {
  const db = new CopilotTestDb(); await saveCopilotContext({ db, userId: '1', sessionId: '11', context });
  assert.deepEqual(await readCopilotContext({ db, userId: '1', sessionId: '11' }), context);
  assert.equal(await readCopilotContext({ db, userId: '2', sessionId: '11' }), null);
  await rejectsCode(saveCopilotContext({ db, userId: '2', sessionId: '11', context }), 'AGENT_SESSION_NOT_FOUND');
  db.sessions[0].expired = true; assert.equal(await readCopilotContext({ db, userId: '1', sessionId: '11' }), null);
});
test('oversized arbitrary context fails closed', async () => {
  const db = new CopilotTestDb(); await rejectsCode(saveCopilotContext({ db, userId: '1', sessionId: '11', context: { ...context, oversized: 'x'.repeat(5000) } }), 'AGENT_CONTEXT_TOO_LARGE');
  assert.equal(db.contexts.length, 0);
});
const generation = (mount, sequence) => `ui_${String(mount).padStart(20, '0')}_${String(sequence).padStart(8, '0')}_0123456789abcdef`;
test('out-of-order canonical context writes cannot replace or renew a newer snapshot', async () => {
  const db = new CopilotTestDb(); const save = version => saveCopilotContext({ db, userId: '1', sessionId: '11', context: { ...context, ui: { ...context.ui, version } } });
  const newest = generation(1000, 2), older = generation(1000, 1);
  await save(newest); const expiry = db.contexts[0].renewals;
  const upsert = db.calls.find(c => c.sql.startsWith('INSERT INTO agent_copilot_contexts'));
  for (const field of ['context_json', 'expires_at', 'context_version']) assert.ok(upsert.sql.includes(`${field} = IF(`));
  assert.ok(upsert.sql.includes('BINARY VALUES(context_version) >= BINARY context_version'));
  await rejectsCode(save(older), 'AGENT_UI_STALE_CONTEXT');
  assert.equal((await readCopilotContext({ db, userId: '1', sessionId: '11' })).ui.version, newest);
  assert.equal(db.contexts[0].renewals, expiry);
  await save(newest); assert.equal(db.contexts[0].renewals, expiry + 1);
  await save(generation(1001, 0)); assert.equal((await readCopilotContext({ db, userId: '1', sessionId: '11' })).ui.version, generation(1001, 0));
  await rejectsCode(save('legacy:old'), 'AGENT_UI_STALE_CONTEXT');
});
test('legacy context generations remain compatible until a canonical generation is stored', async () => {
  const db = new CopilotTestDb();
  await saveCopilotContext({ db, userId: '1', sessionId: '11', context });
  const next = { ...context, ui: { ...context.ui, version: 'legacy:v2' } };
  await saveCopilotContext({ db, userId: '1', sessionId: '11', context: next });
  assert.equal((await readCopilotContext({ db, userId: '1', sessionId: '11' })).ui.version, 'legacy:v2');
  next.ui.version = generation(1, 0); await saveCopilotContext({ db, userId: '1', sessionId: '11', context: next });
  assert.equal((await readCopilotContext({ db, userId: '1', sessionId: '11' })).ui.version, next.ui.version);
});
test('legacy optional reads degrade safely when migration is absent, writes fail closed', async () => {
  const db = new CopilotTestDb(); db.missingSchema = true;
  assert.equal(await readCopilotContext({ db, userId: '1', sessionId: '11' }), null);
  assert.deepEqual(await readRelevantAgentMemory({ db, userId: '1', screenId: 'profile' }), []);
  await rejectsCode(saveCopilotContext({ db, userId: '1', sessionId: '11', context }), 'AGENT_COPILOT_STORAGE_UNAVAILABLE');
  await rejectsCode(create(db), 'AGENT_MEMORY_STORAGE_UNAVAILABLE');
});
test('receipt requires issued operation and initial screen version', async () => {
  const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  for (const patch of [{ planId: 'invented' }, { actionId: 'prescribe' }, { targetId: 'invented' }, { screenVersionBefore: 'stale' }]) await rejectsCode(recordCopilotReceipt({ db, ...receipt, ...patch }), 'AGENT_RECEIPT_PLAN_MISMATCH');
  assert.equal(db.receipts.length, 0);
});
test('receipt is idempotent and never claims backend business success', async () => {
  const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  const first = await recordCopilotReceipt({ db, ...receipt }); const replay = await recordCopilotReceipt({ db, ...receipt, source: 'voice' });
  assert.equal(first.receiptId, replay.receiptId); assert.equal(db.receipts.length, 1);
  assert.equal(first.status, 'local_ui_succeeded'); assert.equal(first.backendConfirmed, false); assert.equal(db.receipts[0].backendConfirmed, false);
});
test('replayed receipt returns the original status rather than contradictory client claims', async () => {
  const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  const first = await recordCopilotReceipt({ db, ...receipt, status: 'rejected' });
  const replay = await recordCopilotReceipt({ db, ...receipt, status: 'succeeded' });
  assert.equal(first.status, 'rejected'); assert.equal(replay.status, 'rejected');
});
test('confirmed preference and fact corrections cannot remain simultaneously active', async () => {
  const db = new CopilotTestDb(); await create(db);
  await create(db, preference({ kind: 'CONFIRMED_FACT', value: { language: 'en' } }));
  const active = await readRelevantAgentMemory({ db, userId: '1', screenId: 'profile' });
  assert.equal(active.length, 1); assert.equal(active[0].value.language, 'en');
});
test('receipt rejects foreign or expired session and expired plan', async () => {
  const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  await rejectsCode(recordCopilotReceipt({ db, ...receipt, userId: '2' }), 'AGENT_SESSION_NOT_FOUND');
  db.plans[0].expired = true; await rejectsCode(recordCopilotReceipt({ db, ...receipt }), 'AGENT_RECEIPT_PLAN_MISMATCH');
});
test('rejected and cancelled stale-screen operations remain auditable while success requires issued version', async () => {
  for (const status of ['rejected', 'cancelled']) {
    const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
    const result = await recordCopilotReceipt({ db, ...receipt, status, screenVersionBefore: 'newer:v2', screenVersionAfter: 'newer:v2', resultCode: status === 'rejected' ? 'stale_context' : 'cancelled' });
    assert.equal(result.status, status); assert.equal(result.backendConfirmed, false);
    assert.equal(db.receipts[0].before, 'newer:v2');
    await rejectsCode(recordCopilotReceipt({ db, ...receipt, status: 'succeeded', screenVersionBefore: 'newer:v2' }), 'AGENT_RECEIPT_PLAN_MISMATCH');
    await rejectsCode(recordCopilotReceipt({ db, ...receipt, status, screenVersionBefore: 'newer:v2', actionId: 'unissued' }), 'AGENT_RECEIPT_PLAN_MISMATCH');
  }
});
test('receipt metadata is bounded, workflow-scoped and idempotently preserves original client claims', async () => {
  const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  for (const patch of [{ resultCode: 'invented' }, { confirmationRef: 'a'.repeat(161) }, { confirmationRef: 'raw transcript with spaces' }, { workflowId: 'another-plan' }]) await rejectsCode(recordCopilotReceipt({ db, ...receipt, ...patch }), patch.workflowId ? 'AGENT_RECEIPT_PLAN_MISMATCH' : 'INVALID_AGENT_RECEIPT');
  assert.equal(db.receipts.length, 0);
  const first = await recordCopilotReceipt({ db, ...receipt, resultCode: 'succeeded', confirmationRef: 'confirm:1', workflowId: plan.id });
  const replay = await recordCopilotReceipt({ db, ...receipt, status: 'rejected', resultCode: 'stale_context', confirmationRef: 'confirm:2', workflowId: plan.id });
  assert.equal(first.resultCode, 'succeeded'); assert.equal(replay.resultCode, 'succeeded'); assert.equal(replay.confirmationRef, 'confirm:1'); assert.equal(replay.confirmationRefSource, 'client_claimed');
  assert.equal(replay.workflowId, plan.id); assert.equal(replay.backendConfirmed, false); assert.equal(db.receipts[0].args_json, '{}');
});
test('legacy receipt omitting optional metadata derives a result code from status', async () => {
  const db = new CopilotTestDb(); await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  const result = await recordCopilotReceipt({ db, ...receipt });
  assert.equal(result.resultCode, 'succeeded'); assert.equal(result.confirmationRef, null); assert.equal(result.workflowId, null);
});
test('valid 160-character protocol action, target and version can be audited', async () => {
  const db = new CopilotTestDb(); const long = 'a'.repeat(160); const issued = { ...plan, version: long, operations: [{ actionId: long, targetId: long, args: {} }] };
  await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan: issued });
  const result = await recordCopilotReceipt({ db, ...receipt, actionId: long, targetId: long, screenVersionBefore: long, screenVersionAfter: long });
  assert.equal(result.ok, true);
});
const constraint = { id: '1', kind: 'CONFIRMED_FACT', key: 'availability.constraint', value: { days: [1], startMinute: 480, endMinute: 540, available: false }, confirmedByUser: true, status: 'active', evidenceRef: 'turn:1' };
const task = { verified: true, type: 'scheduled_task', id: '7', ref: 'task:7', day: 1, minute: 500 };
test('verified availability conflict carries evidence and bounded registered suggestions', () => {
  const conflicts = detectAgentConflicts({ verifiedFacts: [task], memory: [constraint] });
  assert.equal(conflicts.length, 1); assert.equal(conflicts[0].type, 'timing_availability');
  assert.deepEqual(conflicts[0].evidenceRefs, ['task:7', 'turn:1']);
  assert.ok(conflicts[0].allowedResolutions.every(r => AGENT_CONFLICT_RESOLUTIONS.includes(r)));
  assert.deepEqual(detectAgentConflicts({ verifiedFacts: [task], memory: [constraint], allowedResolutions: ['change_dose'] })[0].allowedResolutions, []);
});
test('unverified data, expired memory, inferences and prose never invent conflicts', () => {
  for (const memory of [[{ ...constraint, confirmedByUser: false }], [{ ...constraint, kind: 'INFERRED_PATTERN' }], [{ ...constraint, expiresAt: '2000-01-01' }]]) assert.deepEqual(detectAgentConflicts({ verifiedFacts: [task], memory }), []);
  assert.deepEqual(detectAgentConflicts({ verifiedFacts: [{ ...task, verified: false }], memory: [constraint] }), []);
  assert.deepEqual(conflictsFromToolResults({ toolResults: [{ name: 'get_care_gaps', result: { ok: false, data: { gaps: [{ id: '1', lifecycle_status: 'open' }] } } }], memory: [] }), []);
});
test('clinical timing conflict only offers review actions and flags professional review', () => {
  const conflict = detectAgentConflicts({ verifiedFacts: [{ ...task, clinical: true }], memory: [constraint] })[0];
  assert.equal(conflict.requiresProfessionalReview, true); assert.ok(conflict.allowedResolutions.includes('professional_review')); assert.ok(!conflict.allowedResolutions.includes('change_medication_time'));
});
test('backend read envelope derives real gaps and incomplete Reality Check deterministically', () => {
  const conflicts = conflictsFromToolResults({ toolResults: [{ name: 'get_care_gaps', result: { ok: true, data: { gaps: [{ id: '4', lifecycle_status: 'open' }, { id: '5', lifecycle_status: 'resolved' }] } } }, { name: 'get_reality_check', args: { planId: '3' }, result: { ok: true, data: { questions: [{ selectedAnswer: null }, { selectedAnswer: 'yes' }] } } }] });
  assert.deepEqual(conflicts.map(c => c.type), ['unresolved_care_gap', 'incomplete_reality_check']); assert.deepEqual(conflicts[0].affectedTargets, ['care_gaps.card.4']);
  assert.equal(conflicts[1].explainableFacts.planId,'3');
  assert.deepEqual(conflicts[1].affectedTargets,['reality_check.main']);
});
test('Reality Check empty strings are unanswered while custom notes and choices count as answers', () => {
  const result = questions => conflictsFromToolResults({ toolResults: [{ name: 'get_reality_check', args: { planId: '3' }, result: { ok: true, data: { questions } } }] });
  assert.equal(result([{ selectedAnswer: '', note: '' }, { selectedAnswer: '  ', note: ' ' }, { selectedAnswer: '', note: 'I need help at home' }, { selectedAnswer: 'yes', note: '' }])[0]?.explainableFacts.unansweredCount, 2);
  assert.deepEqual(result([{ selectedAnswer: '', note: 'custom answer' }, { selectedAnswer: 'yes' }]), []);
});
test('audit markers contain fixed strings only and memory markers follow committed writes', async () => {
  const db = new CopilotTestDb(); const messages = []; const original = console.info;
  console.info = (...args) => { assert.equal(db.snapshot, null); messages.push(args); };
  try {
    await create(db);
    await create(db, preference({ value: { language: 'en' } }));
    const item = preference({ kind: 'INFERRED_PATTERN', source: 'verified_event', confirmedByUser: false, confidence: 0.7, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    await createAgentMemory({ db, userId: '1', item, evidence: { verified: true, ref: item.evidenceRef } });
    detectAgentConflicts({ verifiedFacts: [task], memory: [constraint] });
    assert.deepEqual(messages, [['AGENT_MEMORY:CREATED'], ['AGENT_MEMORY:UPDATED'], ['AGENT_MEMORY:INFERENCE'], ['AGENT_CONFLICT:DETECTED']]);
  } finally { console.info = original; }
});
test('actual medicine task kind flags professional review for timing and overlapping schedules', () => {
  const conflicts = conflictsFromToolResults({ toolResults: [{ name: 'get_today_tasks', result: { ok: true, data: { date: '2026-10-05', occurrences: [{ id: '70', scheduleItemId: '7', taskKind: 'medicine', scheduledTime: '08:20', status: 'pending' }, { id: '80', scheduleItemId: '8', taskKind: 'exercise', scheduledTime: '08:20', status: 'pending' }] } } }], memory: [constraint] });
  assert.equal(conflicts.find(c => c.type === 'timing_availability' && c.affectedTargets.includes('care_plan.task.7'))?.requiresProfessionalReview, true);
  assert.equal(conflicts.find(c => c.type === 'overlapping_schedule')?.requiresProfessionalReview, true);
});
test('same-day missed summary never fabricates recurring history', () => {
  assert.deepEqual(conflictsFromToolResults({ toolResults: [{ name: 'get_today_tasks', result: { ok: true, data: { date: '2026-10-05', occurrences: [], summary: { missed: 5 } } } }] }), []);
});
test('verified multi-day performance window supports bounded repeated-miss evidence', () => {
  const tool = { name: 'get_performance_summary', result: { ok: true, data: { periods: { current: { days: 7, startDate: '2026-10-01', endDate: '2026-10-07', summary: { missed: 5 } } } } } };
  const conflicts = conflictsFromToolResults({ toolResults: [tool] });
  assert.equal(conflicts[0]?.type, 'repeated_missed_tasks'); assert.equal(conflicts[0].explainableFacts.missedCount, 5); assert.equal(conflicts[0].explainableFacts.periodDays, 7);
  tool.result.data.periods.current.days = 1; assert.deepEqual(conflictsFromToolResults({ toolResults: [tool] }), []);
});
test('actual task read schema uses schedule item target and flags medication review', () => {
  const conflicts = conflictsFromToolResults({ toolResults: [{ name: 'get_today_tasks', result: { ok: true, data: { date: '2026-10-05', occurrences: [{ id: '70', scheduleItemId: '7', taskKind: 'medication', scheduledTime: '08:20', status: 'pending' }] } } }], memory: [constraint] });
  assert.equal(conflicts.length, 1); assert.deepEqual(conflicts[0].affectedTargets, ['care_plan.task.7']); assert.equal(conflicts[0].requiresProfessionalReview, true);
});
test('overlaps and caregiver mismatch use only verified records', () => {
  const conflicts = detectAgentConflicts({ verifiedFacts: [task, { ...task, id: '8', ref: 'task:8' }, { verified: true, type: 'caregiver_state', ref: 'profile:1', enabled: false }], memory: [{ ...constraint, key: 'caregiver.preference', value: { enabled: true } }] });
  assert.deepEqual(conflicts.map(c => c.type), ['overlapping_schedule', 'caregiver_preference_unmet']);
});
test('all new routes include authentication, limiter and sanitize client authority', async () => {
  const db = new CopilotTestDb(); const routes = [];
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (path, ...handlers) => routes.push({ method, path, handlers })]));
  const authenticate = () => {}; const limiter = () => {};
  mountAgentCopilotRoutes({ app, authenticate, limiter, pool: db, validateContext: value => ({ ok: true, context: value }) });
  assert.equal(routes.length, 8);
  for (const route of routes) assert.deepEqual(route.handlers.slice(0, 2), [authenticate, limiter]);
  const execute = async (path, body) => { const res = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } }; await routes.find(r => r.method === 'post' && r.path === path).handlers.at(-1)({ auth: { userId: '1' }, body }, res); return res; };
  const bad = await execute('/api/agent/copilot/memory', { item: { kind: 'USER_PREFERENCE', key: 'communication.language', value: { language: 'ur' }, confirmedByUser: true, source: 'verified_event' } });
  assert.equal(bad.statusCode, 422);
  const good = await execute('/api/agent/copilot/memory', { item: { kind: 'USER_PREFERENCE', key: 'communication.language', value: { language: 'ur' }, confirmedByUser: true } });
  assert.equal(good.data.success, true); assert.match(db.memory[0].evidence_ref, /^user-api:/); assert.equal(db.memory[0].source, 'user_api');
  await saveCopilotPlan({ db, userId: '1', sessionId: '11', plan });
  const { userId: _receiptUser, ...receiptBody } = receipt;
  const audited = await execute('/api/agent/copilot/receipts', { ...receiptBody, status: 'rejected', screenVersionBefore: 'newer:v2', resultCode: 'stale_context', confirmationRef: 'confirmation:client', workflowId: plan.id });
  assert.equal(audited.data.success, true); assert.equal(audited.data.data.resultCode, 'stale_context'); assert.equal(audited.data.data.backendConfirmed, false);
});
test('repeatable migration declares unsigned foreign IDs and unique receipt fence', async () => {
  assert.equal(AGENT_COPILOT_DDL.length, 4);
  for (const ddl of AGENT_COPILOT_DDL) { assert.match(ddl, /^CREATE TABLE IF NOT EXISTS/); assert.match(ddl, /user_id BIGINT UNSIGNED/); }
  assert.match(AGENT_COPILOT_DDL[3], /UNIQUE KEY agent_copilot_receipt_idempotency_idx \(user_id, session_id, plan_id, action_id, target_id\)/);
  assert.match(AGENT_COPILOT_DDL[1], /context_version VARCHAR\(160\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  for (const field of ['args_json LONGTEXT NOT NULL', 'result_code VARCHAR(40) NOT NULL', 'client_confirmation_ref VARCHAR(160) NULL', 'workflow_id VARCHAR(80) NULL']) assert.ok(AGENT_COPILOT_DDL[3].includes(field));
  const calls = []; const db = { async execute(sql) { calls.push(sql); return [[]]; } };
  await assert.rejects(ensureAgentCopilotSchema(db), /BIGINT UNSIGNED/); assert.equal(calls.length, 1);
  const result = await verifyAgentCopilotSchema(db); assert.equal(result.ok, false); assert.ok(result.problems.some(p => p.includes('idempotency')));
});
