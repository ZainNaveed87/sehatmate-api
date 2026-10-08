import { randomUUID } from 'node:crypto';
import { CopilotError, saveCopilotContext, recordCopilotReceipt, requireCopilotSession } from './agent_copilot_store.js';
import { createAgentMemory, confirmAgentMemory, deactivateAgentMemory, readRelevantAgentMemory, validateAgentMemoryProposal } from './agent_memory.js';
import {continueAgentWorkflow} from './agent_workflow.js';

const exact = (input, fields) => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k => fields.includes(k));
export function mountAgentCopilotRoutes({ app, authenticate, pool, limiter = (_req, _res, next) => next(), validateContext }) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json({ success: true, data: await handler(req) }); }
    catch (error) { return res.status(error instanceof CopilotError ? error.status : 503).json({ success: false, code: error instanceof CopilotError ? error.code : 'AGENT_COPILOT_UNAVAILABLE' }); }
  };
  const user = req => String(req.auth.userId);
  app.post('/api/agent/copilot/continue', authenticate, limiter, route(async req => {
    if(!exact(req.body,['sessionId','planId','context','source'])) throw new CopilotError('INVALID_AGENT_WORKFLOW');
    return continueAgentWorkflow({db:pool,userId:user(req),...req.body});
  }));
  const explicitItem = raw => {
    if (!exact(raw, ['kind', 'key', 'value', 'confirmedByUser']) || raw.confirmedByUser !== true) throw new CopilotError('AGENT_MEMORY_CONFIRMATION_REQUIRED');
    const validated = validateAgentMemoryProposal({ kind: raw.kind, key: raw.key, value: raw.value });
    if (!validated.ok) throw new CopilotError(validated.code);
    const evidenceRef = `user-api:${randomUUID()}`;
    return { item: { ...validated.proposal, confirmedByUser: true, source: 'user_api', evidenceRef }, evidence: { explicitUser: true, ref: evidenceRef } };
  };
  app.post('/api/agent/copilot/context', authenticate, limiter, route(async req => {
    if (!exact(req.body, ['sessionId', 'context']) || typeof validateContext !== 'function') throw new CopilotError('INVALID_AGENT_CONTEXT');
    const valid = validateContext(req.body.context);
    if (!valid?.ok) throw new CopilotError(valid?.code || 'INVALID_AGENT_CONTEXT');
    return saveCopilotContext({ db: pool, userId: user(req), sessionId: req.body.sessionId, context: valid.context });
  }));
  app.post('/api/agent/copilot/receipts', authenticate, limiter, route(async req => {
    if (!exact(req.body, ['sessionId', 'planId', 'actionId', 'targetId', 'status', 'source', 'screenVersionBefore', 'screenVersionAfter', 'resultCode', 'confirmationRef', 'workflowId'])) throw new CopilotError('INVALID_AGENT_RECEIPT');
    return recordCopilotReceipt({ ...req.body, db: pool, userId: user(req) });
  }));
  app.get('/api/agent/copilot/memory', authenticate, limiter, route(req => readRelevantAgentMemory({ db: pool, userId: user(req), review: true, limit: 12 })));
  app.post('/api/agent/copilot/memory', authenticate, limiter, route(async req => {
    if (!exact(req.body, ['sessionId', 'item'])) throw new CopilotError('INVALID_AGENT_MEMORY');
    if (req.body.sessionId) await requireCopilotSession({ db: pool, userId: user(req), sessionId: req.body.sessionId });
    return createAgentMemory({ db: pool, userId: user(req), ...explicitItem(req.body.item) });
  }));
  app.post('/api/agent/copilot/memory/:memoryId/confirm', authenticate, limiter, route(req => {
    if (!exact(req.body, ['confirmedByUser']) || req.body.confirmedByUser !== true) throw new CopilotError('AGENT_MEMORY_CONFIRMATION_REQUIRED');
    return confirmAgentMemory({ db: pool, userId: user(req), memoryId: req.params.memoryId, evidenceRef: `user-confirm:${randomUUID()}` });
  }));
  app.post('/api/agent/copilot/memory/:memoryId/supersede', authenticate, limiter, route(req => {
    if (!exact(req.body, ['item'])) throw new CopilotError('INVALID_AGENT_MEMORY');
    return createAgentMemory({ db: pool, userId: user(req), supersedesId: req.params.memoryId, ...explicitItem(req.body.item) });
  }));
  app.delete('/api/agent/copilot/memory/:memoryId', authenticate, limiter, route(req => deactivateAgentMemory({ db: pool, userId: user(req), memoryId: req.params.memoryId })));
}
