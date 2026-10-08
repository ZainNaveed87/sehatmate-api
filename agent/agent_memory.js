import { CopilotError, missingCopilotSchema, requireId, withCopilotTransaction } from './agent_copilot_store.js';

const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const choice = (value, choices) => choices.includes(value);
const bool = value => exact(value, ['enabled']) && typeof value.enabled === 'boolean';
export const AGENT_MEMORY_KEYS = Object.freeze({
  'communication.language': { screens: ['*'], validate: v => exact(v, ['language']) && choice(v.language, ['en', 'ur', 'roman_ur']) },
  'explanation.detail': { screens: ['*'], validate: v => exact(v, ['level']) && choice(v.level, ['brief', 'step_by_step']) },
  'voice.preference': { screens: ['profile', 'settings'], validate: bool },
  'accessibility.reduced_motion': { screens: ['*'], validate: bool },
  'availability.constraint': { screens: ['reality_check', 'care_plan', 'care_plan_details', 'tasks', 'progress'], validate: v => exact(v, ['days', 'startMinute', 'endMinute', 'available']) && Array.isArray(v.days) && v.days.length > 0 && v.days.length <= 7 && v.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6) && Number.isInteger(v.startMinute) && Number.isInteger(v.endMinute) && v.startMinute >= 0 && v.endMinute <= 1440 && v.endMinute > v.startMinute && typeof v.available === 'boolean' },
  'routine.barrier': { screens: ['reality_check', 'care_plan', 'care_plan_details', 'tasks', 'progress'], validate: v => exact(v, ['category']) && choice(v.category, ['timing', 'transport', 'reminder', 'accessibility', 'caregiver_support']) },
  'caregiver.preference': { screens: ['caregiver', 'profile', 'reality_check', 'care_plan'], validate: bool },
  'workflow.preference': { screens: ['*'], validate: v => exact(v, ['mode']) && choice(v.mode, ['guided', 'independent']) },
  'routine.missed_pattern': { screens: ['care_plan', 'tasks', 'progress', 'reality_check'], validate: v => exact(v, ['periodDays', 'missedCount', 'timeOfDay']) && Number.isInteger(v.periodDays) && v.periodDays >= 1 && v.periodDays <= 90 && Number.isInteger(v.missedCount) && v.missedCount >= 2 && v.missedCount <= 1000 && choice(v.timeOfDay, ['morning', 'afternoon', 'evening', 'any']) },
});
function validateMemory(input, evidence, now = Date.now()) {
  if (!exact(input, ['kind', 'key', 'value', 'source', 'evidenceRef', 'confidence', 'confirmedByUser', 'expiresAt', 'sensitivityClass']) || !choice(input.kind, ['CONFIRMED_FACT', 'USER_PREFERENCE', 'INFERRED_PATTERN']) || !Object.hasOwn(AGENT_MEMORY_KEYS,input.key) || !AGENT_MEMORY_KEYS[input.key].validate(input.value)) throw new CopilotError('INVALID_AGENT_MEMORY');
  if (!/^[a-zA-Z0-9_.:/-]{1,191}$/.test(input.evidenceRef || '')) throw new CopilotError('AGENT_MEMORY_EVIDENCE_REQUIRED');
  const inferred = input.kind === 'INFERRED_PATTERN';
  if (inferred) {
    if (input.source !== 'verified_event' || evidence?.verified !== true || evidence.ref !== input.evidenceRef || input.confirmedByUser === true || !input.expiresAt) throw new CopilotError('AGENT_MEMORY_VERIFIED_EVIDENCE_REQUIRED');
  } else if (!choice(input.source, ['user_selection', 'user_confirmation', 'user_api']) || input.confirmedByUser !== true || evidence?.explicitUser !== true || evidence.ref !== input.evidenceRef) throw new CopilotError('AGENT_MEMORY_CONFIRMATION_REQUIRED');
  if (input.key === 'routine.missed_pattern' && !inferred && input.source !== 'user_confirmation') throw new CopilotError('INVALID_AGENT_MEMORY_KIND');
  const confidence = inferred ? input.confidence : 1;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new CopilotError('INVALID_AGENT_MEMORY_CONFIDENCE');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now || expiresAt.getTime() > now + 366 * 86400000)) throw new CopilotError('INVALID_AGENT_MEMORY_EXPIRY');
  if (input.sensitivityClass && !choice(input.sensitivityClass, ['preference', 'operational'])) throw new CopilotError('INVALID_AGENT_MEMORY_SENSITIVITY');
  return { ...input, confidence, confirmedByUser: !inferred, expiresAt, sensitivityClass: input.sensitivityClass || (input.key.includes('constraint') || input.key.startsWith('routine.') ? 'operational' : 'preference') };
}
const fromRow = row => ({ id: String(row.id), kind: row.kind, key: row.memory_key, value: JSON.parse(row.value_json), source: row.source, evidenceRef: row.evidence_ref, confidence: Number(row.confidence), confirmedByUser: Boolean(row.confirmed_by_user), status: row.status, expiresAt: row.expires_at, supersededBy: row.superseded_by ? String(row.superseded_by) : null, sensitivityClass: row.sensitivity_class, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at });
async function storage(work) {
  try { return await work(); } catch (error) { if (missingCopilotSchema(error)) throw new CopilotError('AGENT_MEMORY_STORAGE_UNAVAILABLE', 503); throw error; }
}
export async function createAgentMemory({ db, userId, item, evidence, supersedesId = null }) {
  userId = requireId(userId);
  const safe = validateMemory(item, evidence);
  if (supersedesId) requireId(supersedesId);
  let supersededExisting = false;
  const result = await storage(() => withCopilotTransaction(db, async connection => {
    // A user-row lock serializes same-user corrections, including first insert.
    const [users] = await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!users.length) throw new CopilotError('AGENT_MEMORY_NOT_FOUND', 404);
    if (supersedesId) {
      const [old] = await connection.execute(`SELECT id, memory_key FROM agent_memory WHERE id = ? AND user_id = ? AND status = 'active' FOR UPDATE`, [String(supersedesId), userId]);
      if (!old.length || old[0].memory_key !== safe.key) throw new CopilotError('AGENT_MEMORY_NOT_FOUND', 404);
    }
    const [result] = await connection.execute(`INSERT INTO agent_memory (user_id, kind, memory_key, value_json, source, evidence_ref, confidence, confirmed_by_user, expires_at, sensitivity_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [userId, safe.kind, safe.key, JSON.stringify(safe.value), safe.source, safe.evidenceRef, safe.confidence, Number(safe.confirmedByUser), safe.expiresAt, safe.sensitivityClass]);
    const id = String(result.insertId);
    // Preserve history, but never leave contradictory active values in a class.
    const [superseded] = await connection.execute(`UPDATE agent_memory SET status = 'superseded', superseded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND memory_key = ? AND (kind = ? OR (kind <> 'INFERRED_PATTERN' AND ? <> 'INFERRED_PATTERN')) AND status = 'active' AND id <> ?`, [id, userId, safe.key, safe.kind, safe.kind, id]);
    supersededExisting = Number(superseded.affectedRows || 0) > 0 || supersedesId !== null;
    if (supersedesId) await connection.execute(`UPDATE agent_memory SET status = 'superseded', superseded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND id <> ?`, [id, String(supersedesId), userId, id]);
    return { ok: true, memory: { id, ...safe, status: 'active' } };
  }));
  // Fixed markers only, after the transaction committed. No IDs, values or evidence.
  console.info(safe.kind === 'INFERRED_PATTERN' ? 'AGENT_MEMORY:INFERENCE' : supersededExisting ? 'AGENT_MEMORY:UPDATED' : 'AGENT_MEMORY:CREATED');
  return result;
}
export async function supersedeAgentMemory(args) { return createAgentMemory(args); }
export function validateAgentMemoryProposal(raw) {
  if (!exact(raw, ['kind', 'key', 'value']) || !['CONFIRMED_FACT', 'USER_PREFERENCE'].includes(raw.kind) || raw.key === 'routine.missed_pattern' || !Object.hasOwn(AGENT_MEMORY_KEYS,raw.key) || !AGENT_MEMORY_KEYS[raw.key].validate(raw.value)) return { ok: false, code: 'INVALID_AGENT_MEMORY_PROPOSAL' };
  return { ok: true, proposal: { kind: raw.kind, key: raw.key, value: JSON.parse(JSON.stringify(raw.value)) } };
}
export async function confirmAgentMemory({ db, userId, memoryId, evidenceRef }) {
  requireId(userId); requireId(memoryId);
  const [rows] = await storage(() => db.execute(`SELECT * FROM agent_memory WHERE id = ? AND user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) LIMIT 1`, [String(memoryId), String(userId)]));
  if (!rows.length) throw new CopilotError('AGENT_MEMORY_NOT_FOUND', 404);
  const old = fromRow(rows[0]);
  return createAgentMemory({ db, userId, supersedesId: memoryId, item: { kind: old.kind === 'INFERRED_PATTERN' ? 'CONFIRMED_FACT' : old.kind, key: old.key, value: old.value, source: 'user_confirmation', evidenceRef, confirmedByUser: true, expiresAt: old.expiresAt }, evidence: { explicitUser: true, ref: evidenceRef } });
}
export async function deactivateAgentMemory({ db, userId, memoryId }) {
  requireId(userId); requireId(memoryId);
  const [result] = await storage(() => db.execute(`UPDATE agent_memory SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'active'`, [String(memoryId), String(userId)]));
  if (!result.affectedRows) throw new CopilotError('AGENT_MEMORY_NOT_FOUND', 404);
  return { ok: true };
}
export async function readRelevantAgentMemory({ db, userId, screenId, keys, limit = 8, review = false }) {
  requireId(userId);
  screenId = ({ care_plan_detail: 'care_plan_details', care_plans: 'care_plan', routine_settings: 'tasks', today: 'tasks', family_care: 'caregiver', simulation: 'care_plan', care_gaps: 'care_plan', care_gap_detail: 'care_plan' })[screenId] || screenId;
  const requested = Array.isArray(keys) ? keys.filter(key => Object.hasOwn(AGENT_MEMORY_KEYS, key)) : null;
  const allowed = Object.keys(AGENT_MEMORY_KEYS).filter(key => (review || AGENT_MEMORY_KEYS[key].screens.includes('*') || AGENT_MEMORY_KEYS[key].screens.includes(screenId)) && (!requested || requested.includes(key)));
  if (!allowed.length) return [];
  const bounded = Math.max(1, Math.min(12, Math.floor(Number(limit) || 8)));
  try {
    const [rows] = await db.execute(`SELECT * FROM agent_memory WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) AND memory_key IN (${allowed.map(() => '?').join(',')}) ORDER BY confirmed_by_user DESC, updated_at DESC, id DESC LIMIT ${bounded}`, [String(userId), ...allowed]);
    const items=rows.flatMap(row => { try { const item = fromRow(row); return AGENT_MEMORY_KEYS[item.key]?.validate(item.value) ? [item] : []; } catch { return []; } });
    if(!review&&items.length) {
      await db.execute(`UPDATE agent_memory SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'active' AND id IN (${items.map(()=>'?').join(',')})`,[String(userId),...items.map(item=>item.id)]);
      const usedAt=new Date();
      for(const item of items) item.lastUsedAt=usedAt;
    }
    return items;
  } catch (error) { if (missingCopilotSchema(error)) return []; throw error; }
}
// Called only with server-owned capability execution envelopes. UI snapshots,
// model prose and single-day summaries never become inferred memory.
export async function rememberVerifiedAgentPatterns({db,userId,toolResults=[]}) {
  requireId(userId);
  for(const tool of toolResults.slice(0,3)) {
    if(!['get_performance_summary','compare_performance'].includes(tool?.name)||tool.result?.ok!==true) continue;
    const window=tool.result.data?.periods?.current;
    if(!window||!/^\d{4}-\d{2}-\d{2}$/.test(window.startDate||'')||!/^\d{4}-\d{2}-\d{2}$/.test(window.endDate||'')||
      !Number.isInteger(window.days)||window.days<2||window.days>90||!Number.isInteger(window.summary?.missed)||window.summary.missed<2||window.summary.missed>1000) continue;
    const value={periodDays:window.days,missedCount:window.summary.missed,timeOfDay:'any'};
    const evidenceRef=`${tool.name}:${window.startDate}:${window.endDate}`;
    const existing=await readRelevantAgentMemory({db,userId,keys:['routine.missed_pattern'],review:true});
    if(existing.some(item=>item.kind==='INFERRED_PATTERN'&&item.evidenceRef===evidenceRef&&JSON.stringify(item.value)===JSON.stringify(value))) continue;
    await createAgentMemory({db,userId,item:{kind:'INFERRED_PATTERN',key:'routine.missed_pattern',value,source:'verified_event',evidenceRef,
      confidence:0.7,confirmedByUser:false,expiresAt:new Date(Date.now()+7*86400000).toISOString()},evidence:{verified:true,ref:evidenceRef}});
  }
}
