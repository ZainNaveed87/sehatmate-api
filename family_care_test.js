import assert from 'node:assert/strict';

import {
  acceptFamilyInvitation,
  authorizeFamilyAccess,
  createFamilyInvitation,
  DEFAULT_FAMILY_PERMISSION_SCOPES,
  readFamilyCarePlans,
  readFamilyMemberSummary,
  revokeFamilyRelationship,
  updateFamilyPermissions,
} from './services/family_care_service.js';
import './agent/agent_read_tools.js';
import { executeAgentCapability } from './agent/agent_capability_registry.js';
import { validateAgentPlan } from './agent/agent_planner.js';
import { authorizeAgentNavigationIntent } from './agent/agent_navigation_registry.js';
import {
  resolveAgentConversationReference,
  reviewPlanAgainstResolvedReference,
} from './agent/agent_reference_resolver.js';

const PATIENT = '42';
const CAREGIVER = '77';
const OTHER = '99';
const RELATIONSHIP_ID = '501';
const INVITATION_ID = '301';
const OK = { affectedRows: 1, insertId: Number(INVITATION_ID) };

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function relationship(overrides = {}) {
  return {
    id: Number(RELATIONSHIP_ID),
    care_recipient_user_id: Number(PATIENT),
    caregiver_user_id: Number(CAREGIVER),
    relationship_label: 'Ammi',
    status: 'active',
    accepted_at: '2026-09-04 10:00:00',
    revoked_at: null,
    recipient_name: 'Ali Patient',
    recipient_email: 'ali@example.com',
    caregiver_name: 'Zain Caregiver',
    caregiver_email: 'zain@example.com',
    recipient_patient_name: 'Ammi',
    ...overrides,
  };
}

function invitation(overrides = {}) {
  return {
    id: Number(INVITATION_ID),
    care_recipient_user_id: Number(PATIENT),
    caregiver_user_id: Number(CAREGIVER),
    relationship_label: 'Ammi',
    status: 'pending',
    scopes_json: JSON.stringify(Object.fromEntries(
      DEFAULT_FAMILY_PERMISSION_SCOPES.map((scope) => [scope, true]),
    )),
    created_by_user_id: Number(PATIENT),
    ...overrides,
  };
}

function createPool({
  caregiverUser = { id: Number(CAREGIVER), name: 'Zain Caregiver', email: 'zain@example.com' },
  relationshipRow = relationship(),
  invitationRow = invitation(),
  permissions = Object.fromEntries(DEFAULT_FAMILY_PERMISSION_SCOPES.map((scope) => [scope, true])),
  duplicatePending = false,
  duplicateActive = false,
  planRows = [{
    id: 8,
    title: 'Recovery plan',
    status: 'active',
    start_date: '2026-09-04',
    readiness_score: 83,
    understanding_score: 0,
    activated_at: '2026-09-04 09:00:00',
    completed_at: null,
    completion_reason: null,
    completed_by: null,
    duration_mode: 'prescription',
    suggested_end_date: null,
    planned_end_date: null,
    created_at: '2026-09-04 09:00:00',
    updated_at: '2026-09-04 09:00:00',
    document_count: 0,
    task_count: 1,
    open_gap_count: 0,
    setup_step: 'complete',
  }],
} = {}) {
  const calls = [];
  let relationshipStatus = relationshipRow?.status || 'active';
  let invitationStatus = invitationRow?.status || 'pending';
  const permissionMap = { ...permissions };

  const execute = async (sql, params = []) => {
    const text = normalizeSql(sql);
    calls.push({ sql: text, params });

    if (text.startsWith('SELECT id, name, email FROM users WHERE email = ?')) {
      return caregiverUser ? [[caregiverUser]] : [[]];
    }
    if (text.startsWith('SELECT id FROM family_relationships') && text.includes("status = 'active'")) {
      return duplicateActive ? [[{ id: Number(RELATIONSHIP_ID) }]] : [[]];
    }
    if (text.startsWith('SELECT id FROM family_invitations') && text.includes("status = 'pending'")) {
      return duplicatePending ? [[{ id: Number(INVITATION_ID) }]] : [[]];
    }
    if (text.startsWith('INSERT INTO family_invitations')) {
      return [OK];
    }
    if (text.startsWith('SELECT i.id, i.care_recipient_user_id')) {
      if (!invitationRow) return [[]];
      return [[{ ...invitationRow, status: invitationStatus }]];
    }
    if (text.startsWith('SELECT id, care_recipient_user_id, caregiver_user_id')) {
      if (!invitationRow) return [[]];
      return [[{ ...invitationRow, status: invitationStatus }]];
    }
    if (text.startsWith('INSERT INTO family_relationships')) {
      return [{ affectedRows: 1, insertId: Number(RELATIONSHIP_ID) }];
    }
    if (text.startsWith('INSERT INTO family_permissions')) {
      permissionMap[params[1]] = params[2] === 1;
      return [OK];
    }
    if (text.startsWith('UPDATE family_invitations')) {
      invitationStatus = text.includes("status = 'accepted'") ? 'accepted' : invitationStatus;
      return [OK];
    }
    if (text.startsWith('UPDATE family_relationships')) {
      relationshipStatus = 'revoked';
      return [OK];
    }
    if (text.includes('FROM family_relationships r')) {
      if (!relationshipRow) return [[]];
      const actor = String(params[0]);
      const requestedId = params.find((param) => String(param) === RELATIONSHIP_ID);
      const requestedStatus = params.includes('active') ? 'active' : null;
      const actorAllowed = actor === PATIENT || actor === CAREGIVER;
      const idAllowed = requestedId == null || String(requestedId) === RELATIONSHIP_ID;
      const statusAllowed = requestedStatus == null || relationshipStatus === requestedStatus;
      return actorAllowed && idAllowed && statusAllowed
        ? [[{ ...relationshipRow, status: relationshipStatus }]]
        : [[]];
    }
    if (text.startsWith('SELECT scope, allowed FROM family_permissions')) {
      return [Object.entries(permissionMap).map(([scope, allowed]) => ({
        scope,
        allowed: allowed ? 1 : 0,
      }))];
    }
    if (text.startsWith('INSERT INTO family_activity_audit')) {
      return [OK];
    }
    if (text.includes('FROM care_plans') && text.includes('WHERE care_plans.user_id = ?')) {
      return [planRows];
    }
    if (text.startsWith('SELECT id, title FROM care_plans WHERE id = ? AND user_id = ?')) {
      return String(params[1]) === PATIENT ? [[{ id: 8, title: 'Recovery plan' }]] : [[]];
    }
    if (text.startsWith('SELECT id, title, readiness_score FROM care_plans')) {
      return String(params[0]) === PATIENT ? [[{ id: 8, title: 'Recovery plan', readiness_score: 83 }]] : [[]];
    }
    if (text.includes('FROM care_task_occurrences') && text.includes('p.title AS plan_title')) {
      return [[]];
    }
    if (text.includes('FROM care_gaps g') && text.includes('COUNT(*) AS open_count')) {
      return [[{ open_count: 0 }]];
    }
    if (/^SELECT|^WITH|^SHOW|^DESCRIBE/i.test(text)) return [[]];
    return [OK];
  };

  return {
    execute,
    calls,
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => calls.push({ sql: 'BEGIN', params: [] }),
        commit: async () => calls.push({ sql: 'COMMIT', params: [] }),
        rollback: async () => calls.push({ sql: 'ROLLBACK', params: [] }),
        release: () => {},
      };
    },
  };
}

function callsMatching(pool, pattern) {
  return pool.calls.filter((call) => pattern.test(call.sql));
}

await test('authenticated user can create safe invitation', async () => {
  const pool = createPool();
  const result = await createFamilyInvitation({
    pool,
    actorUserId: PATIENT,
    caregiverEmail: 'zain@example.com',
    relationshipLabel: 'Ammi',
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.invitation.status, 'pending');
  assert.equal(result.data.invitation.caregiverUserId, CAREGIVER);
  const insert = callsMatching(pool, /INSERT INTO family_invitations/)[0];
  assert.equal(insert.params[0], PATIENT);
  assert.equal(insert.params[1], Number(CAREGIVER));
});

await test('user cannot invite self', async () => {
  const pool = createPool({
    caregiverUser: { id: Number(PATIENT), name: 'Ali Patient', email: 'ali@example.com' },
  });
  const result = await createFamilyInvitation({
    pool,
    actorUserId: PATIENT,
    caregiverEmail: 'ali@example.com',
    relationshipLabel: 'Self',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_SELF_INVITATION');
  assert.equal(callsMatching(pool, /INSERT INTO family_invitations/).length, 0);
});

await test('duplicate invitation rejected', async () => {
  const result = await createFamilyInvitation({
    pool: createPool({ duplicatePending: true }),
    actorUserId: PATIENT,
    caregiverEmail: 'zain@example.com',
    relationshipLabel: 'Ammi',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_INVITATION_ALREADY_PENDING');
});

await test('duplicate active relationship rejected before invite', async () => {
  const result = await createFamilyInvitation({
    pool: createPool({ duplicateActive: true }),
    actorUserId: PATIENT,
    caregiverEmail: 'zain@example.com',
    relationshipLabel: 'Ammi',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_RELATIONSHIP_ALREADY_ACTIVE');
});

await test('only invited recipient can accept invitation', async () => {
  const result = await acceptFamilyInvitation({
    pool: createPool(),
    actorUserId: OTHER,
    invitationId: INVITATION_ID,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_INVITATION_NOT_FOUND');
});

await test('accepted relationship becomes active with scoped permissions', async () => {
  const pool = createPool();
  const result = await acceptFamilyInvitation({
    pool,
    actorUserId: CAREGIVER,
    invitationId: INVITATION_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.relationship.id, RELATIONSHIP_ID);
  assert.equal(result.data.relationship.status, 'active');
  assert.ok(callsMatching(pool, /INSERT INTO family_relationships/).length === 1);
  assert.ok(callsMatching(pool, /INSERT INTO family_permissions/).length >= DEFAULT_FAMILY_PERMISSION_SCOPES.length);
});

await test('revoked relationship cannot access data', async () => {
  const pool = createPool();
  const revoked = await revokeFamilyRelationship({
    pool,
    actorUserId: PATIENT,
    relationshipId: RELATIONSHIP_ID,
  });
  assert.equal(revoked.ok, true);
  const access = await authorizeFamilyAccess({
    pool,
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
    scope: 'care_plan.read',
  });
  assert.equal(access.ok, false);
  assert.equal(access.code, 'FAMILY_RELATIONSHIP_NOT_ACTIVE');
});

await test('unrelated caregiver cannot read patient data', async () => {
  const result = await authorizeFamilyAccess({
    pool: createPool(),
    actorUserId: OTHER,
    relationshipId: RELATIONSHIP_ID,
    scope: 'care_plan.read',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_RELATIONSHIP_NOT_FOUND');
});

await test('care_plan.read scope enforced', async () => {
  const result = await readFamilyCarePlans({
    pool: createPool({ permissions: { 'care_plan.read': false } }),
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_PERMISSION_DENIED');
});

await test('task.read scope enforced', async () => {
  const result = await readFamilyMemberSummary({
    pool: createPool({ permissions: { 'task.read': false } }),
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
    compact: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.today.allowed, false);
  assert.equal(result.data.summary.today.requiredScope, 'task.read');
});

await test('care_gap.read scope enforced', async () => {
  const result = await readFamilyMemberSummary({
    pool: createPool({ permissions: { 'care_gap.read': false } }),
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
    compact: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.careGaps.allowed, false);
});

await test('simulation.read scope enforced', async () => {
  const result = await readFamilyMemberSummary({
    pool: createPool({ permissions: { 'simulation.read': false } }),
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
    compact: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.simulation.allowed, false);
});

await test('performance.read scope enforced', async () => {
  const result = await readFamilyMemberSummary({
    pool: createPool({ permissions: { 'performance.read': false } }),
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
    compact: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.performance.allowed, false);
});

await test('Family summary reuses existing services with target patient id', async () => {
  const pool = createPool();
  const result = await readFamilyCarePlans({
    pool,
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
  });
  assert.equal(result.ok, true);
  const planRead = callsMatching(pool, /WHERE care_plans\.user_id = \?/)[0];
  assert.deepEqual(planRead.params, [PATIENT]);
});

await test('no duplicate medical care records are created by family reads', async () => {
  const pool = createPool();
  await readFamilyCarePlans({
    pool,
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
  });
  assert.equal(callsMatching(pool, /INSERT INTO care_plans|INSERT INTO care_task_occurrences|INSERT INTO care_gaps/).length, 0);
});

await test('patient remains authoritative care-plan owner', async () => {
  const pool = createPool();
  await readFamilyCarePlans({
    pool,
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
  });
  const planRead = callsMatching(pool, /WHERE care_plans\.user_id = \?/)[0];
  assert.equal(planRead.params[0], PATIENT);
  assert.notEqual(planRead.params[0], CAREGIVER);
});

await test('permission revocation immediately blocks subsequent requests', async () => {
  const pool = createPool();
  const before = await readFamilyCarePlans({
    pool,
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
  });
  assert.equal(before.ok, true);
  const update = await updateFamilyPermissions({
    pool,
    actorUserId: PATIENT,
    relationshipId: RELATIONSHIP_ID,
    scopes: { 'care_plan.read': false },
  });
  assert.equal(update.ok, true);
  const after = await readFamilyCarePlans({
    pool,
    actorUserId: CAREGIVER,
    relationshipId: RELATIONSHIP_ID,
  });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'FAMILY_PERMISSION_DENIED');
});

await test('Agent cannot read family data without active relationship', async () => {
  const result = await executeAgentCapability({
    name: 'family_member_summary',
    pool: createPool({ relationshipRow: null }),
    userId: CAREGIVER,
    args: { relationshipId: RELATIONSHIP_ID },
  });
  assert.equal(result.ok, false);
});

await test('Agent cannot read family data without scope', async () => {
  const result = await executeAgentCapability({
    name: 'family_member_care_plans',
    pool: createPool({ permissions: { 'care_plan.read': false } }),
    userId: CAREGIVER,
    args: { relationshipId: RELATIONSHIP_ID },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_PERMISSION_DENIED');
});

await test('Agent rejects model-supplied target user id', async () => {
  const result = validateAgentPlan({
    intent: 'family_injection',
    capabilityCalls: [{
      name: 'family_member_summary',
      args: { relationshipId: RELATIONSHIP_ID, targetUserId: PATIENT },
    }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_CAPABILITY_ARGS');
});

await test('Agent resolves explicit authorized family member', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(),
    userId: CAREGIVER,
    message: 'Ammi ke care plans batao',
    familyMembers: [{ type: 'family_member', id: RELATIONSHIP_ID, title: 'Ammi' }],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.entity.type, 'family_member');
  assert.equal(result.entity.id, RELATIONSHIP_ID);
});

await test('ambiguous family-member reference asks clarification', async () => {
  const result = await resolveAgentConversationReference({
    pool: createPool(),
    userId: CAREGIVER,
    message: 'unke gaps kholo',
    recentEntities: [
      { type: 'family_member', id: '1', title: 'Ammi' },
      { type: 'family_member', id: '2', title: 'Abu' },
    ],
  });
  assert.equal(result.status, 'ambiguous');
});

await test('arbitrary family navigation is rejected', async () => {
  const result = validateAgentPlan({
    intent: 'bad_nav',
    capabilityCalls: [],
    navigationIntent: { target: 'family_admin_url', params: { relationshipId: RELATIONSHIP_ID } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_NAVIGATION_INTENT');
});

await test('family navigation requires relationship authorization', async () => {
  const result = await authorizeAgentNavigationIntent({
    pool: createPool({ relationshipRow: null }),
    userId: CAREGIVER,
    intent: { target: 'family_member_detail', params: { relationshipId: RELATIONSHIP_ID } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FAMILY_MEMBER_NOT_FOUND');
});

await test('voice receives no extra Family Care authority', async () => {
  const typed = await executeAgentCapability({
    name: 'family_member_care_plans',
    pool: createPool({ permissions: { 'care_plan.read': false } }),
    userId: CAREGIVER,
    args: { relationshipId: RELATIONSHIP_ID },
  });
  const voice = await executeAgentCapability({
    name: 'family_member_care_plans',
    pool: createPool({ permissions: { 'care_plan.read': false } }),
    userId: CAREGIVER,
    args: { relationshipId: RELATIONSHIP_ID },
  });
  assert.equal(typed.code, voice.code);
  assert.equal(voice.code, 'FAMILY_PERMISSION_DENIED');
});

await test('family action cannot mutate without Phase D confirmation', async () => {
  const result = validateAgentPlan({
    intent: 'skip_family_task',
    capabilityCalls: [{
      name: 'set_task_outcome',
      args: {
        occurrenceId: '11',
        outcome: 'skipped',
        baseStatus: 'pending',
        operationKey: 'forged',
        relationshipId: RELATIONSHIP_ID,
      },
    }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
});

await test('caregiver cannot modify clinical instructions/dose/prescription', async () => {
  const result = validateAgentPlan({
    intent: 'change_dose',
    capabilityCalls: [{ name: 'change_prescription_dose', args: { relationshipId: RELATIONSHIP_ID } }],
    navigationIntent: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_CAPABILITY');
});

await test('resolved family reference binding rejects substituted id', async () => {
  const reviewed = reviewPlanAgainstResolvedReference({
    resolution: { status: 'resolved', entity: { type: 'family_member', id: RELATIONSHIP_ID } },
    plan: {
      capabilityCalls: [{ name: 'family_member_summary', args: { relationshipId: '999' } }],
      navigationIntent: null,
    },
  });
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.code, 'AGENT_REFERENCE_MISMATCH');
});

console.log(`\nFamily Care tests passed: ${passed}`);
