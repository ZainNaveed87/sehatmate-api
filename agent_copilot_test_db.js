// In-memory SQL boundary used only by Phase 2 tests. Unknown SQL fails loudly.
export class CopilotTestDb {
  constructor() {
    this.users = new Set(['1', '2']); this.sessions = [{ id: '11', user: '1' }, { id: '22', user: '2' }];
    this.memory = []; this.contexts = []; this.plans = []; this.receipts = []; this.calls = []; this.sequence = 0; this.missingSchema = false;
  }
  async beginTransaction() { this.snapshot = structuredClone({ memory: this.memory, sequence: this.sequence }); }
  async commit() { this.snapshot = null; }
  async rollback() { if (this.snapshot) Object.assign(this, this.snapshot); this.snapshot = null; }
  async execute(sql, params = []) {
    sql = sql.replace(/\s+/g, ' ').trim(); this.calls.push({ sql, params });
    const id = () => String(++this.sequence);
    if (this.missingSchema && /(?:FROM|INTO|UPDATE) agent_(?:memory|copilot_)/.test(sql)) throw Object.assign(new Error('missing migration'), { code: 'ER_NO_SUCH_TABLE' });
    if (sql.startsWith('SELECT id FROM users')) return [[...(this.users.has(params[0]) ? [{ id: params[0] }] : [])]];
    if (sql.startsWith('SELECT id FROM agent_sessions')) return [this.sessions.filter(s => s.id === params[0] && s.user === params[1] && !s.expired).map(s => ({ id: s.id }))];
    if (sql.startsWith('INSERT INTO agent_memory')) {
      const [user_id, kind, memory_key, value_json, source, evidence_ref, confidence, confirmed_by_user, expires_at, sensitivity_class] = params;
      const row = { id: id(), user_id, kind, memory_key, value_json, source, evidence_ref, confidence, confirmed_by_user, expires_at, sensitivity_class, status: 'active', updated_at: new Date(), created_at: new Date() };
      this.memory.push(row); return [{ insertId: row.id, affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM agent_memory')) {
      let rows = this.memory.filter(r => r.status === 'active' && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now()));
      if (sql.includes('WHERE id = ?')) rows = rows.filter(r => r.id === params[0] && r.user_id === params[1]);
      else {
        rows = rows.filter(r => r.user_id === params[0] && params.slice(1).includes(r.memory_key));
        rows.sort((a, b) => b.confirmed_by_user - a.confirmed_by_user || Number(b.id) - Number(a.id));
        rows = rows.slice(0, Number(/LIMIT (\d+)/.exec(sql)?.[1] || 1));
      }
      return [rows.map(r => ({ ...r }))];
    }
    if(sql.startsWith('UPDATE agent_memory SET last_used_at')) {
      const matches=this.memory.filter(row=>row.user_id===params[0]&&params.slice(1).includes(row.id)&&row.status==='active');
      for(const row of matches) row.last_used_at=new Date();
      return [{affectedRows:matches.length}];
    }
    if (sql.startsWith('UPDATE agent_memory')) {
      let matches;
      if (sql.includes("status = 'inactive'")) matches = this.memory.filter(r => r.id === params[0] && r.user_id === params[1] && r.status === 'active');
      else if (sql.includes('memory_key = ?')) matches = this.memory.filter(r => r.user_id === params[1] && r.memory_key === params[2] && (r.kind === params[3] || r.kind !== 'INFERRED_PATTERN' && params[4] !== 'INFERRED_PATTERN') && r.status === 'active' && r.id !== params[5]);
      else matches = this.memory.filter(r => r.id === params[1] && r.user_id === params[2] && r.id !== params[3]);
      for (const row of matches) { row.status = sql.includes("status = 'inactive'") ? 'inactive' : 'superseded'; if (row.status === 'superseded') row.superseded_by = params[0]; }
      return [{ affectedRows: matches.length }];
    }
    if (sql.startsWith('INSERT INTO agent_copilot_contexts')) {
      const [user, session, context_json, context_version] = params; const row = this.contexts.find(c => c.user === user && c.session === session);
      const canonical = version => /^ui_[0-9]{20}_[0-9]{8}_[a-f0-9]{16}$/.test(version);
      const replace = !row || !canonical(row.context_version) && !canonical(context_version) || canonical(context_version) && (!canonical(row.context_version) || context_version >= row.context_version);
      if (row && replace) Object.assign(row, { context_json, context_version, expired: false, renewals: row.renewals + 1 }); else if (!row) this.contexts.push({ user, session, context_json, context_version, renewals: 1 });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT context_version FROM agent_copilot_contexts')) return [this.contexts.filter(c => c.user === params[0] && c.session === params[1]).map(c => ({ context_version: c.context_version }))];
    if (sql.startsWith('SELECT c.context_json')) return [this.contexts.filter(c => c.user === params[0] && c.session === params[1] && !c.expired && this.sessions.some(s => s.id === c.session && s.user === c.user && !s.expired))];
    if (sql.startsWith('INSERT INTO agent_copilot_plans')) { const [user, session, plan_id, screen_version, plan_json] = params; this.plans.push({ user, session, plan_id, screen_version, plan_json }); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT plan_json')) return [this.plans.filter(p => p.user === params[0] && p.session === params[1] && p.plan_id === params[2] && !p.expired)];
    if (sql.startsWith('INSERT INTO agent_copilot_receipts')) {
      const [user, session, plan, action, target, status, source, before, after, args_json, result_code, client_confirmation_ref, workflow_id] = params;
      let row = this.receipts.find(r => r.user === user && r.session === session && r.plan === plan && r.action === action && r.target === target);
      if (!row) { row = { id: id(), user, session, plan, action, target, status, source, before, after, args_json, result_code, client_confirmation_ref, workflow_id, backendConfirmed: false }; this.receipts.push(row); }
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, result_status, result_code, client_confirmation_ref, workflow_id FROM agent_copilot_receipts')) return [this.receipts.filter(r => r.user === params[0] && r.session === params[1] && r.plan === params[2] && r.action === params[3] && r.target === params[4]).map(r => ({ id: r.id, result_status: r.status, result_code: r.result_code, client_confirmation_ref: r.client_confirmation_ref, workflow_id: r.workflow_id }))];
    throw new Error(`Unexpected fake DB query: ${sql}`);
  }
}
