// Transport-independent Phase 2 persistence. Never import a provider or open a DB here.
export class CopilotError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}
export const missingCopilotSchema = error => ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error?.code);
export function requireId(value) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) throw new CopilotError('INVALID_AGENT_ID');
  return id;
}
export async function requireCopilotSession({ db, userId, sessionId }) {
  userId = requireId(userId); sessionId = requireId(sessionId);
  const [rows] = await db.execute(`SELECT id FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1`, [sessionId, userId]);
  if (!rows.length) throw new CopilotError('AGENT_SESSION_NOT_FOUND', 404);
}
export async function withCopilotTransaction(db, work) {
  const connection = typeof db.getConnection === 'function' ? await db.getConnection() : db;
  if (typeof connection.beginTransaction !== 'function') throw new CopilotError('AGENT_STORAGE_TRANSACTION_REQUIRED', 503);
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; }
  finally { if (connection !== db) connection.release(); }
}
const boundedJson = (value, max = 4096) => {
  let json;
  try { json = JSON.stringify(value); } catch { throw new CopilotError('INVALID_AGENT_CONTEXT'); }
  if (!json || Buffer.byteLength(json, 'utf8') > max) throw new CopilotError('AGENT_CONTEXT_TOO_LARGE');
  return json;
};
const canonicalContextGeneration = /^ui_[0-9]{20}_[0-9]{8}_[a-f0-9]{16}$/;
export async function saveCopilotContext({ db, userId, sessionId, context }) {
  const json = boundedJson(context);
  await requireCopilotSession({ db, userId, sessionId });
  if (!context || typeof context.screenId !== 'string' || !context.ui || context.ui.screenId !== context.screenId || typeof context.ui.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(context.ui.version)) throw new CopilotError('INVALID_AGENT_CONTEXT');
  try {
    // Conditional replacement is atomic even when HTTP requests arrive out of order.
    // Canonical generations use fixed-width mount epoch + sequence + secure nonce.
    // Legacy opaque fixtures/clients remain usable until this session adopts canonical generations.
    const pattern = canonicalContextGeneration.source;
    const replace = `((context_version NOT REGEXP '${pattern}' AND VALUES(context_version) NOT REGEXP '${pattern}') OR (VALUES(context_version) REGEXP '${pattern}' AND (context_version NOT REGEXP '${pattern}' OR BINARY VALUES(context_version) >= BINARY context_version)))`;
    await db.execute(`INSERT INTO agent_copilot_contexts (user_id, session_id, context_json, context_version, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE)) ON DUPLICATE KEY UPDATE context_json = IF(${replace}, VALUES(context_json), context_json), expires_at = IF(${replace}, VALUES(expires_at), expires_at), context_version = IF(${replace}, VALUES(context_version), context_version)`, [String(userId), String(sessionId), json, context.ui.version]);
    // affectedRows cannot identify a refused replacement with MYSQL CLIENT_FOUND_ROWS.
    const [stored] = await db.execute(`SELECT context_version FROM agent_copilot_contexts WHERE user_id = ? AND session_id = ? LIMIT 1`, [String(userId), String(sessionId)]);
    if (!stored.length) throw new CopilotError('AGENT_CONTEXT_PERSISTENCE_FAILED', 503);
    if (stored[0].context_version !== context.ui.version) throw new CopilotError('AGENT_UI_STALE_CONTEXT', 409);
  } catch (error) { if (missingCopilotSchema(error)) throw new CopilotError('AGENT_COPILOT_STORAGE_UNAVAILABLE', 503); throw error; }
  return { ok: true };
}
export async function readCopilotContext({ db, userId, sessionId }) {
  if (!sessionId) return null;
  requireId(userId); requireId(sessionId);
  try {
    const [rows] = await db.execute(`SELECT c.context_json FROM agent_copilot_contexts c JOIN agent_sessions s ON s.id = c.session_id AND s.user_id = c.user_id WHERE c.user_id = ? AND c.session_id = ? AND c.expires_at > CURRENT_TIMESTAMP AND s.expires_at > CURRENT_TIMESTAMP LIMIT 1`, [String(userId), String(sessionId)]);
    const context = rows[0] ? JSON.parse(rows[0].context_json) : null;
    return context && Buffer.byteLength(JSON.stringify(context), 'utf8') <= 4096 ? context : null;
  } catch (error) { if (missingCopilotSchema(error) || error instanceof SyntaxError) return null; throw error; }
}
export async function saveCopilotPlan({ db, userId, sessionId, plan }) {
  await requireCopilotSession({ db, userId, sessionId });
  if (!plan || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(plan.id || '') || typeof plan.version !== 'string' || !plan.version || plan.version.length > 160 || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 4) throw new CopilotError('INVALID_AGENT_UI_PLAN');
  const json = boundedJson(plan, 8192);
  try {
    await db.execute(`INSERT INTO agent_copilot_plans (user_id, session_id, plan_id, screen_version, plan_json, expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE))`, [String(userId), String(sessionId), plan.id, plan.version, json]);
  } catch (error) { if (missingCopilotSchema(error)) throw new CopilotError('AGENT_COPILOT_STORAGE_UNAVAILABLE', 503); throw error; }
  return { ok: true };
}
export const AGENT_COPILOT_RECEIPT_RESULT_CODES = Object.freeze(['succeeded', 'rejected', 'duplicate', 'account_changed', 'workflow_paused', 'stale_context', 'workflow_busy', 'invalid_arguments', 'target_not_found', 'action_unavailable', 'cancelled', 'action_failed']);
export async function recordCopilotReceipt({ db, userId, sessionId, planId, actionId, targetId, status, source, screenVersionBefore, screenVersionAfter, resultCode, confirmationRef = null, workflowId = null }) {
  const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
  if (![planId, actionId, targetId].every(token) || planId.length > 80 || !['succeeded', 'rejected', 'cancelled'].includes(status) || !['text', 'voice'].includes(source) || !token(screenVersionBefore) || !token(screenVersionAfter)) throw new CopilotError('INVALID_AGENT_RECEIPT');
  resultCode = resultCode ?? status;
  if (!AGENT_COPILOT_RECEIPT_RESULT_CODES.includes(resultCode) || confirmationRef !== null && !token(confirmationRef) || workflowId !== null && (!token(workflowId) || workflowId.length > 80)) throw new CopilotError('INVALID_AGENT_RECEIPT');
  await requireCopilotSession({ db, userId, sessionId });
  try {
    const [rows] = await db.execute(`SELECT plan_json, screen_version FROM agent_copilot_plans WHERE user_id = ? AND session_id = ? AND plan_id = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1`, [String(userId), String(sessionId), planId]);
    let plan;
    try { plan = JSON.parse(rows[0]?.plan_json || 'null'); } catch { plan = null; }
    const operation = plan?.operations?.find(op => op.actionId === actionId && op.targetId === targetId);
    if (!plan || !operation || status === 'succeeded' && rows[0].screen_version !== screenVersionBefore || workflowId !== null && workflowId !== plan.id) throw new CopilotError('AGENT_RECEIPT_PLAN_MISMATCH', 409);
    // These are client claims, never authorization or backend-confirmed success.
    // Issued UI operations currently have an empty, closed args schema.
    if (operation.args != null && (typeof operation.args !== 'object' || Array.isArray(operation.args) || Object.keys(operation.args).length !== 0)) throw new CopilotError('AGENT_RECEIPT_PLAN_MISMATCH', 409);
    await db.execute(`INSERT INTO agent_copilot_receipts (user_id, session_id, plan_id, action_id, target_id, result_status, source, screen_version_before, screen_version_after, args_json, result_code, client_confirmation_ref, workflow_id, backend_confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [String(userId), String(sessionId), planId, actionId, targetId, status, source, screenVersionBefore, screenVersionAfter, '{}', resultCode, confirmationRef, workflowId]);
    const [receipts] = await db.execute(`SELECT id, result_status, result_code, client_confirmation_ref, workflow_id FROM agent_copilot_receipts WHERE user_id = ? AND session_id = ? AND plan_id = ? AND action_id = ? AND target_id = ? LIMIT 1`, [String(userId), String(sessionId), planId, actionId, targetId]);
    if (!receipts.length) throw new CopilotError('AGENT_RECEIPT_PERSISTENCE_FAILED', 503);
    const recordedStatus = receipts[0].result_status;
    return { ok: true, receiptId: String(receipts[0].id), backendConfirmed: false, status: recordedStatus === 'succeeded' ? 'local_ui_succeeded' : recordedStatus, resultCode: receipts[0].result_code, confirmationRef: receipts[0].client_confirmation_ref ?? null, confirmationRefSource: receipts[0].client_confirmation_ref ? 'client_claimed' : null, workflowId: receipts[0].workflow_id ?? null };
  } catch (error) { if (missingCopilotSchema(error)) throw new CopilotError('AGENT_COPILOT_STORAGE_UNAVAILABLE', 503); throw error; }
}
export { readRelevantAgentMemory } from './agent_memory.js';
