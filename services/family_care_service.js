/**
 * Family Care authorization and coordination layer.
 *
 * This service owns only relationship, invitation, permission and audit
 * state. Medical/care data stays in the existing patient-owned tables and
 * is read by passing the verified care-recipient userId into the existing
 * domain services.
 */

import {
  carePlanJson,
  listCarePlans,
} from './plan_query_service.js';
import { listCareGaps } from './care_gap_service.js';
import { readSimulationState } from './simulation_service.js';
import { sendTransactionalEmail } from './email_service.js';
import {
  nextTaskFromTodayState,
  readPerformanceSummary,
  readTodayTasksState,
} from './performance_summary_service.js';
import {
  cleanText,
  idPattern,
  parseStoredJson,
  parseStoredObject,
  taskOutcomeDate,
} from './shared_utils.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const FAMILY_PERMISSION_SCOPES = Object.freeze([
  'care_plan.read',
  'schedule.read',
  'task.read',
  'care_gap.read',
  'simulation.read',
  'performance.read',
  'task.support',
  'simulation.participate',
  'schedule.review_request',
]);

export const DEFAULT_FAMILY_PERMISSION_SCOPES = Object.freeze([
  'care_plan.read',
  'schedule.read',
  'task.read',
  'care_gap.read',
  'simulation.read',
  'performance.read',
]);

const READABLE_SCOPES = new Set(FAMILY_PERMISSION_SCOPES);

const FAMILY_SCOPE_LABELS = Object.freeze({
  'care_plan.read': 'Care plans',
  'schedule.read': 'Schedule',
  'task.read': 'Today tasks',
  'care_gap.read': 'Care gaps',
  'simulation.read': 'Simulation',
  'performance.read': 'Performance',
  'task.support': 'Practical task support',
  'simulation.participate': 'Readiness support context',
  'schedule.review_request': 'Schedule review requests',
});

function error(code, message, data = undefined) {
  return {
    ok: false,
    code,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

function normalizeEmail(value) {
  const email = cleanText(value, 191).toLowerCase();
  return emailPattern.test(email) ? email : '';
}

function normalizeRelationshipLabel(value) {
  return cleanText(value, 80) || 'Family caregiver';
}

function normalizeScopePatch(value) {
  const output = {};
  if (Array.isArray(value)) {
    for (const scope of value) {
      const key = cleanText(scope, 80);
      if (READABLE_SCOPES.has(key)) output[key] = true;
    }
    return output;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [rawScope, rawAllowed] of Object.entries(value)) {
    const scope = cleanText(rawScope, 80);
    if (!READABLE_SCOPES.has(scope)) return null;
    output[scope] = rawAllowed === true;
  }
  return output;
}

function defaultScopeMap(scopes = DEFAULT_FAMILY_PERMISSION_SCOPES) {
  const out = {};
  for (const scope of FAMILY_PERMISSION_SCOPES) out[scope] = false;
  for (const scope of scopes) {
    if (READABLE_SCOPES.has(scope)) out[scope] = true;
  }
  return out;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requestedScopeLabels(scopes) {
  return Object.entries(scopes || {})
    .filter(([, allowed]) => allowed === true)
    .map(([scope]) => FAMILY_SCOPE_LABELS[scope] || scope)
    .filter(Boolean);
}

function familyInvitationEmailPayload({
  caregiver,
  inviter,
  relationshipLabel,
  requestedScopes,
}) {
  const caregiverName = cleanText(caregiver?.name, 120);
  const inviterName = cleanText(inviter?.name, 120) || 'A SehatMate user';
  const label = normalizeRelationshipLabel(relationshipLabel);
  const scopeLabels = requestedScopeLabels(requestedScopes);
  const scopeText = scopeLabels.length
    ? scopeLabels.join(', ')
    : 'No permissions selected yet';
  const greeting = caregiverName ? `Hi ${caregiverName},` : 'Hi,';

  const text = [
    greeting,
    '',
    `${inviterName} invited you to SehatMate Family Care as ${label}.`,
    `Requested permissions: ${scopeText}.`,
    '',
    'Access starts only after you sign in to SehatMate and accept the invitation.',
    'Open SehatMate -> Family Care -> Pending invitations.',
    '',
    'Family access never allows dose, diagnosis, prescription or verified medical-instruction changes unless a separate explicitly designed safe workflow exists.',
  ].join('\n');

  const scopeItems = scopeLabels.length
    ? scopeLabels.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('')
    : '<li>No permissions selected yet</li>';

  return {
    to: caregiver.email,
    subject: "You've been invited to SehatMate Family Care",
    text,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#172033">
        <h2 style="margin:0 0 16px">SehatMate Family Care invitation</h2>
        <p style="line-height:1.6">${escapeHtml(greeting)}</p>
        <p style="line-height:1.6">
          ${escapeHtml(inviterName)} invited you to SehatMate Family Care as
          <strong>${escapeHtml(label)}</strong>.
        </p>
        <p style="line-height:1.6;margin-bottom:8px">Requested permissions:</p>
        <ul style="line-height:1.6;margin-top:0">${scopeItems}</ul>
        <p style="line-height:1.6">
          Access starts only after you sign in to SehatMate and accept the
          invitation.
        </p>
        <p style="line-height:1.6">
          Open SehatMate &rarr; Family Care &rarr; Pending invitations.
        </p>
        <p style="line-height:1.6;color:#667085">
          Family access never allows dose, diagnosis, prescription or verified
          medical-instruction changes unless a separate explicitly designed safe
          workflow exists.
        </p>
      </div>
    `,
    tags: [
      {
        name: 'category',
        value: 'family_care_invitation',
      },
    ],
  };
}

function invitationJson(row) {
  return {
    id: String(row.id),
    careRecipientUserId: String(row.care_recipient_user_id),
    caregiverUserId: String(row.caregiver_user_id),
    relationshipLabel: row.relationship_label,
    status: row.status,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    revokedAt: row.revoked_at,
    inviter: row.inviter_id == null ? null : {
      id: String(row.inviter_id),
      name: row.inviter_name || '',
      email: row.inviter_email || '',
    },
    caregiver: row.caregiver_id == null ? null : {
      id: String(row.caregiver_id),
      name: row.caregiver_name || '',
      email: row.caregiver_email || '',
    },
    careRecipient: row.recipient_id == null ? null : {
      id: String(row.recipient_id),
      name: row.recipient_name || row.recipient_patient_name || '',
      email: row.recipient_email || '',
      patientName: row.recipient_patient_name || '',
    },
    requestedScopes: defaultScopeMap(
      Object.entries(parseStoredObject(row.scopes_json))
        .filter(([, allowed]) => allowed === true)
        .map(([scope]) => scope),
    ),
  };
}

function relationshipJson(row, permissions = null, summary = null, actorUserId = null) {
  const actorIsRecipient = actorUserId != null &&
    String(actorUserId) === String(row.care_recipient_user_id);
  const memberName = actorIsRecipient
    ? (row.caregiver_name || 'Family caregiver')
    : (row.recipient_patient_name || row.recipient_name || 'Family member');
  return {
    id: String(row.id),
    careRecipientUserId: String(row.care_recipient_user_id),
    caregiverUserId: String(row.caregiver_user_id),
    relationshipLabel: row.relationship_label,
    status: row.status,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    role: actorIsRecipient ? 'care_recipient' : 'caregiver',
    member: {
      id: String(actorIsRecipient ? row.caregiver_user_id : row.care_recipient_user_id),
      name: memberName,
      email: actorIsRecipient ? row.caregiver_email : row.recipient_email,
      patientName: actorIsRecipient ? '' : (row.recipient_patient_name || ''),
    },
    permissions: permissions || {},
    ...(summary ? { summary } : {}),
  };
}

function familyInstructionJson(item) {
  return {
    ...item,
    id: String(item.id),
    title: cleanText(item.title, 160),
    instruction: cleanText(item.instruction, 4000),
    timing: cleanText(item.timing, 160) || null,
    document_id: item.document_id == null ? null : String(item.document_id),
    duplicate_of_instruction_id:
      item.duplicate_of_instruction_id == null
        ? null
        : String(item.duplicate_of_instruction_id),
    safety_sources: parseStoredJson(item.safety_sources),
  };
}

function familyScheduleTaskJson(item) {
  return {
    ...item,
    id: String(item.id),
    instruction_id: item.instruction_id == null ? null : String(item.instruction_id),
    caregiver_id: item.caregiver_id == null ? null : String(item.caregiver_id),
  };
}

async function recordFamilyAudit({
  db,
  actorUserId,
  eventType,
  careRecipientUserId = null,
  caregiverUserId = null,
  relationshipId = null,
  invitationId = null,
  metadata = null,
}) {
  try {
    await db.execute(
      `INSERT INTO family_activity_audit (
        actor_user_id, care_recipient_user_id, caregiver_user_id,
        relationship_id, invitation_id, event_type, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actorUserId,
        careRecipientUserId,
        caregiverUserId,
        relationshipId,
        invitationId,
        cleanText(eventType, 80),
        metadata ? JSON.stringify(metadata).slice(0, 2000) : null,
      ],
    );
  } catch {
    // Audit is important but should not break a user-safe response.
  }
}

async function readRelationshipRows(pool, actorUserId, { relationshipId = null, status = 'active' } = {}) {
  const params = [actorUserId, actorUserId];
  let idFilter = '';
  if (relationshipId != null) {
    idFilter = ' AND r.id = ?';
    params.push(relationshipId);
  }
  let statusFilter = '';
  if (status) {
    statusFilter = ' AND r.status = ?';
    params.push(status);
  }
  const [rows] = await pool.execute(
    `SELECT r.id, r.care_recipient_user_id, r.caregiver_user_id,
      r.relationship_label, r.status, r.accepted_at, r.revoked_at,
      recipient.name AS recipient_name, recipient.email AS recipient_email,
      caregiver.name AS caregiver_name, caregiver.email AS caregiver_email,
      pp.patient_name AS recipient_patient_name
     FROM family_relationships r
     JOIN users recipient ON recipient.id = r.care_recipient_user_id
     JOIN users caregiver ON caregiver.id = r.caregiver_user_id
     LEFT JOIN patient_profiles pp ON pp.user_id = r.care_recipient_user_id
     WHERE (r.care_recipient_user_id = ? OR r.caregiver_user_id = ?)
       ${idFilter}
       ${statusFilter}
     ORDER BY r.updated_at DESC, r.id DESC`,
    params,
  );
  return rows;
}

export async function ensureFamilyCareSchema(db) {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS family_invitations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      care_recipient_user_id BIGINT UNSIGNED NOT NULL,
      caregiver_user_id BIGINT UNSIGNED NOT NULL,
      relationship_label VARCHAR(80) NOT NULL,
      status ENUM('pending', 'accepted', 'declined', 'revoked') NOT NULL DEFAULT 'pending',
      scopes_json LONGTEXT NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      accepted_at TIMESTAMP NULL DEFAULT NULL,
      declined_at TIMESTAMP NULL DEFAULT NULL,
      revoked_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY family_invitation_pair_status_unique (care_recipient_user_id, caregiver_user_id, status),
      KEY family_invitation_caregiver_status_idx (caregiver_user_id, status, created_at),
      KEY family_invitation_recipient_status_idx (care_recipient_user_id, status, created_at),
      CONSTRAINT family_invitation_recipient_fk
        FOREIGN KEY (care_recipient_user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT family_invitation_caregiver_fk
        FOREIGN KEY (caregiver_user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT family_invitation_creator_fk
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await db.execute(
    `CREATE TABLE IF NOT EXISTS family_relationships (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      care_recipient_user_id BIGINT UNSIGNED NOT NULL,
      caregiver_user_id BIGINT UNSIGNED NOT NULL,
      relationship_label VARCHAR(80) NOT NULL,
      status ENUM('active', 'revoked') NOT NULL DEFAULT 'active',
      invitation_id BIGINT UNSIGNED NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY family_relationship_pair_status_unique (care_recipient_user_id, caregiver_user_id, status),
      KEY family_relationship_caregiver_status_idx (caregiver_user_id, status, updated_at),
      KEY family_relationship_recipient_status_idx (care_recipient_user_id, status, updated_at),
      CONSTRAINT family_relationship_recipient_fk
        FOREIGN KEY (care_recipient_user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT family_relationship_caregiver_fk
        FOREIGN KEY (caregiver_user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT family_relationship_creator_fk
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT family_relationship_invitation_fk
        FOREIGN KEY (invitation_id) REFERENCES family_invitations (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await db.execute(
    `CREATE TABLE IF NOT EXISTS family_permissions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      relationship_id BIGINT UNSIGNED NOT NULL,
      scope VARCHAR(80) NOT NULL,
      allowed TINYINT(1) NOT NULL DEFAULT 0,
      updated_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY family_permission_scope_unique (relationship_id, scope),
      KEY family_permission_scope_idx (scope, allowed),
      CONSTRAINT family_permission_relationship_fk
        FOREIGN KEY (relationship_id) REFERENCES family_relationships (id) ON DELETE CASCADE,
      CONSTRAINT family_permission_updated_by_fk
        FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await db.execute(
    `CREATE TABLE IF NOT EXISTS family_activity_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_user_id BIGINT UNSIGNED NOT NULL,
      care_recipient_user_id BIGINT UNSIGNED NULL,
      caregiver_user_id BIGINT UNSIGNED NULL,
      relationship_id BIGINT UNSIGNED NULL,
      invitation_id BIGINT UNSIGNED NULL,
      event_type VARCHAR(80) NOT NULL,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY family_audit_actor_idx (actor_user_id, created_at),
      KEY family_audit_relationship_idx (relationship_id, created_at),
      KEY family_audit_invitation_idx (invitation_id, created_at),
      CONSTRAINT family_audit_actor_fk
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT family_audit_recipient_fk
        FOREIGN KEY (care_recipient_user_id) REFERENCES users (id) ON DELETE SET NULL,
      CONSTRAINT family_audit_caregiver_fk
        FOREIGN KEY (caregiver_user_id) REFERENCES users (id) ON DELETE SET NULL,
      CONSTRAINT family_audit_relationship_fk
        FOREIGN KEY (relationship_id) REFERENCES family_relationships (id) ON DELETE SET NULL,
      CONSTRAINT family_audit_invitation_fk
        FOREIGN KEY (invitation_id) REFERENCES family_invitations (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

export async function readFamilyPermissions(pool, relationshipId) {
  const [rows] = await pool.execute(
    `SELECT scope, allowed
     FROM family_permissions
     WHERE relationship_id = ?`,
    [relationshipId],
  );
  const permissions = defaultScopeMap([]);
  for (const row of rows) {
    const scope = cleanText(row.scope, 80);
    if (READABLE_SCOPES.has(scope)) permissions[scope] = row.allowed === true || row.allowed === 1;
  }
  return permissions;
}

export async function authorizeFamilyAccess({
  pool,
  actorUserId,
  relationshipId,
  scope = null,
}) {
  if (!idPattern.test(String(relationshipId || ''))) {
    return error('INVALID_FAMILY_RELATIONSHIP_ID', 'Invalid family relationship ID.');
  }
  const rows = await readRelationshipRows(pool, actorUserId, {
    relationshipId,
    status: null,
  });
  const relationship = rows[0];
  if (!relationship) {
    return error('FAMILY_RELATIONSHIP_NOT_FOUND', 'Family relationship not found.');
  }
  if (relationship.status !== 'active') {
    return error('FAMILY_RELATIONSHIP_NOT_ACTIVE', 'Family access is not active.');
  }
  const actorIsRecipient = String(actorUserId) === String(relationship.care_recipient_user_id);
  const actorIsCaregiver = String(actorUserId) === String(relationship.caregiver_user_id);
  if (!actorIsRecipient && !actorIsCaregiver) {
    return error('FAMILY_RELATIONSHIP_NOT_FOUND', 'Family relationship not found.');
  }
  const permissions = await readFamilyPermissions(pool, relationship.id);
  if (scope && !READABLE_SCOPES.has(scope)) {
    return error('INVALID_FAMILY_PERMISSION_SCOPE', 'Invalid family permission scope.');
  }
  if (scope && actorIsCaregiver && permissions[scope] !== true) {
    return error('FAMILY_PERMISSION_DENIED', 'This family permission has not been granted.');
  }
  return {
    ok: true,
    data: {
      relationship,
      permissions,
      role: actorIsRecipient ? 'care_recipient' : 'caregiver',
      targetUserId: String(relationship.care_recipient_user_id),
    },
  };
}

export async function verifyFamilyRelationshipReference({ pool, userId, relationshipId }) {
  const authorized = await authorizeFamilyAccess({
    pool,
    actorUserId: userId,
    relationshipId,
  });
  if (!authorized.ok) {
    return {
      ok: false,
      code: 'FAMILY_MEMBER_NOT_FOUND',
      message: 'Family member is not available for this user.',
    };
  }
  return {
    ok: true,
    data: {
      relationshipId: String(authorized.data.relationship.id),
      title: relationshipJson(
        authorized.data.relationship,
        authorized.data.permissions,
        null,
        userId,
      ).member.name,
    },
  };
}

export async function listFamilyMemberReferences({ pool, userId }) {
  const rows = await readRelationshipRows(pool, userId, { status: 'active' });
  return rows.map((row) => ({
    type: 'family_member',
    id: String(row.id),
    title: relationshipJson(row, null, null, userId).member.name,
  }));
}

export async function createFamilyInvitation({
  pool,
  actorUserId,
  caregiverEmail,
  relationshipLabel,
  scopes = null,
  emailSender = sendTransactionalEmail,
}) {
  const email = normalizeEmail(caregiverEmail);
  if (!email) return error('INVALID_FAMILY_INVITATION', 'Enter a valid SehatMate account email.');
  const label = normalizeRelationshipLabel(relationshipLabel);
  const requestedScopes = scopes == null
    ? defaultScopeMap(DEFAULT_FAMILY_PERMISSION_SCOPES)
    : normalizeScopePatch(scopes);
  if (!requestedScopes) {
    return error('INVALID_FAMILY_PERMISSION_SCOPE', 'Choose valid family permission scopes.');
  }

  const [users] = await pool.execute(
    'SELECT id, name, email FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  const caregiver = users[0];
  if (!caregiver) {
    return error('FAMILY_INVITEE_NOT_FOUND', 'That SehatMate account is not available for invitation.');
  }
  if (String(caregiver.id) === String(actorUserId)) {
    return error('FAMILY_SELF_INVITATION', 'You cannot invite yourself as a family caregiver.');
  }

  const [activeRows] = await pool.execute(
    `SELECT id FROM family_relationships
     WHERE care_recipient_user_id = ? AND caregiver_user_id = ? AND status = 'active'
     LIMIT 1`,
    [actorUserId, caregiver.id],
  );
  if (activeRows.length) {
    return error('FAMILY_RELATIONSHIP_ALREADY_ACTIVE', 'This family relationship is already active.');
  }
  const [pendingRows] = await pool.execute(
    `SELECT id FROM family_invitations
     WHERE care_recipient_user_id = ? AND caregiver_user_id = ? AND status = 'pending'
     LIMIT 1`,
    [actorUserId, caregiver.id],
  );
  if (pendingRows.length) {
    return error('FAMILY_INVITATION_ALREADY_PENDING', 'A pending invitation already exists.');
  }

  const [inviterRows] = await pool.execute(
    'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
    [actorUserId],
  );
  const inviter = inviterRows[0] || {
    id: actorUserId,
    name: 'A SehatMate user',
    email: '',
  };

  const [result] = await pool.execute(
    `INSERT INTO family_invitations (
      care_recipient_user_id, caregiver_user_id, relationship_label,
      status, scopes_json, created_by_user_id
     ) VALUES (?, ?, ?, 'pending', ?, ?)`,
    [
      actorUserId,
      caregiver.id,
      label,
      JSON.stringify(requestedScopes),
      actorUserId,
    ],
  );
  await recordFamilyAudit({
    db: pool,
    actorUserId,
    careRecipientUserId: actorUserId,
    caregiverUserId: caregiver.id,
    invitationId: result.insertId,
    eventType: 'invitation_created',
    metadata: { scopes: Object.keys(requestedScopes).filter((scope) => requestedScopes[scope]) },
  });

  let emailDelivery = { sent: false };
  try {
    await emailSender(familyInvitationEmailPayload({
      caregiver,
      inviter,
      relationshipLabel: label,
      requestedScopes,
    }));
    emailDelivery = { sent: true };
    await recordFamilyAudit({
      db: pool,
      actorUserId,
      careRecipientUserId: actorUserId,
      caregiverUserId: caregiver.id,
      invitationId: result.insertId,
      eventType: 'invitation_email_sent',
    });
  } catch (err) {
    console.error(
      'Family invitation email delivery failed.',
      {
        invitationId: String(result.insertId),
        caregiverUserId: String(caregiver.id),
        statusCode: err?.statusCode || null,
      },
    );
    await recordFamilyAudit({
      db: pool,
      actorUserId,
      careRecipientUserId: actorUserId,
      caregiverUserId: caregiver.id,
      invitationId: result.insertId,
      eventType: 'invitation_email_failed',
    });
  }

  return {
    ok: true,
    message: emailDelivery.sent
      ? 'Invitation sent by email and added to SehatMate.'
      : 'Invitation created in SehatMate, but the email could not be delivered.',
    data: {
      invitation: {
        id: String(result.insertId),
        careRecipientUserId: String(actorUserId),
        caregiverUserId: String(caregiver.id),
        relationshipLabel: label,
        status: 'pending',
        requestedScopes,
        caregiver: {
          id: String(caregiver.id),
          name: caregiver.name,
          email: caregiver.email,
        },
      },
      emailDelivery,
    },
  };
}

async function readInvitation(pool, invitationId) {
  const [rows] = await pool.execute(
    `SELECT i.id, i.care_recipient_user_id, i.caregiver_user_id,
      i.relationship_label, i.status, i.scopes_json, i.created_by_user_id,
      i.accepted_at, i.declined_at, i.revoked_at, i.created_at,
      inviter.id AS inviter_id, inviter.name AS inviter_name, inviter.email AS inviter_email,
      caregiver.id AS caregiver_id, caregiver.name AS caregiver_name, caregiver.email AS caregiver_email,
      recipient.id AS recipient_id, recipient.name AS recipient_name, recipient.email AS recipient_email,
      pp.patient_name AS recipient_patient_name
     FROM family_invitations i
     JOIN users inviter ON inviter.id = i.created_by_user_id
     JOIN users caregiver ON caregiver.id = i.caregiver_user_id
     JOIN users recipient ON recipient.id = i.care_recipient_user_id
     LEFT JOIN patient_profiles pp ON pp.user_id = i.care_recipient_user_id
     WHERE i.id = ?
     LIMIT 1`,
    [invitationId],
  );
  return rows[0] || null;
}

export async function listFamilyHome({ pool, actorUserId }) {
  const relationshipRows = await readRelationshipRows(pool, actorUserId, { status: 'active' });
  const relationships = [];
  for (const row of relationshipRows) {
    const permissions = await readFamilyPermissions(pool, row.id);
    let summary = null;
    if (String(actorUserId) === String(row.caregiver_user_id)) {
      summary = await readFamilyMemberSummary({
        pool,
        actorUserId,
        relationshipId: String(row.id),
        compact: true,
      }).then((result) => (result.ok ? result.data.summary : null));
    }
    relationships.push(relationshipJson(row, permissions, summary, actorUserId));
  }

  const [invitationRows] = await pool.execute(
    `SELECT i.id, i.care_recipient_user_id, i.caregiver_user_id,
      i.relationship_label, i.status, i.scopes_json, i.created_by_user_id,
      i.accepted_at, i.declined_at, i.revoked_at, i.created_at,
      inviter.id AS inviter_id, inviter.name AS inviter_name, inviter.email AS inviter_email,
      caregiver.id AS caregiver_id, caregiver.name AS caregiver_name, caregiver.email AS caregiver_email,
      recipient.id AS recipient_id, recipient.name AS recipient_name, recipient.email AS recipient_email,
      pp.patient_name AS recipient_patient_name
     FROM family_invitations i
     JOIN users inviter ON inviter.id = i.created_by_user_id
     JOIN users caregiver ON caregiver.id = i.caregiver_user_id
     JOIN users recipient ON recipient.id = i.care_recipient_user_id
     LEFT JOIN patient_profiles pp ON pp.user_id = i.care_recipient_user_id
     WHERE (i.caregiver_user_id = ? OR i.care_recipient_user_id = ?)
       AND i.status = 'pending'
     ORDER BY i.created_at DESC, i.id DESC`,
    [actorUserId, actorUserId],
  );

  return {
    ok: true,
    data: {
      relationships,
      pendingInvitations: invitationRows.map(invitationJson),
      permissionScopes: FAMILY_PERMISSION_SCOPES,
    },
  };
}

export async function acceptFamilyInvitation({ pool, actorUserId, invitationId }) {
  if (!idPattern.test(String(invitationId || ''))) {
    return error('INVALID_FAMILY_INVITATION_ID', 'Invalid family invitation ID.');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT id, care_recipient_user_id, caregiver_user_id, relationship_label,
        status, scopes_json, created_by_user_id
       FROM family_invitations
       WHERE id = ?
       LIMIT 1 FOR UPDATE`,
      [invitationId],
    );
    const invitation = rows[0];
    if (!invitation || String(invitation.caregiver_user_id) !== String(actorUserId)) {
      await connection.rollback();
      return error('FAMILY_INVITATION_NOT_FOUND', 'Family invitation not found.');
    }
    if (invitation.status !== 'pending') {
      await connection.rollback();
      return error('FAMILY_INVITATION_NOT_PENDING', 'This family invitation is not pending.');
    }
    const [activeRows] = await connection.execute(
      `SELECT id FROM family_relationships
       WHERE care_recipient_user_id = ? AND caregiver_user_id = ? AND status = 'active'
       LIMIT 1`,
      [invitation.care_recipient_user_id, invitation.caregiver_user_id],
    );
    if (activeRows.length) {
      await connection.rollback();
      return error('FAMILY_RELATIONSHIP_ALREADY_ACTIVE', 'This family relationship is already active.');
    }
    const [inserted] = await connection.execute(
      `INSERT INTO family_relationships (
        care_recipient_user_id, caregiver_user_id, relationship_label,
        status, invitation_id, created_by_user_id, accepted_at
       ) VALUES (?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)`,
      [
        invitation.care_recipient_user_id,
        invitation.caregiver_user_id,
        invitation.relationship_label,
        invitation.id,
        invitation.created_by_user_id,
      ],
    );
    const relationshipId = inserted.insertId;
    const scopes = defaultScopeMap(
      Object.entries(parseStoredObject(invitation.scopes_json))
        .filter(([, allowed]) => allowed === true)
        .map(([scope]) => scope),
    );
    for (const [scope, allowed] of Object.entries(scopes)) {
      await connection.execute(
        `INSERT INTO family_permissions (
          relationship_id, scope, allowed, updated_by_user_id
         ) VALUES (?, ?, ?, ?)`,
        [relationshipId, scope, allowed ? 1 : 0, invitation.care_recipient_user_id],
      );
    }
    await connection.execute(
      `UPDATE family_invitations
       SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [invitation.id],
    );
    await recordFamilyAudit({
      db: connection,
      actorUserId,
      careRecipientUserId: invitation.care_recipient_user_id,
      caregiverUserId: invitation.caregiver_user_id,
      relationshipId,
      invitationId: invitation.id,
      eventType: 'invitation_accepted',
    });
    await connection.commit();
    const rowsAfter = await readRelationshipRows(pool, actorUserId, {
      relationshipId,
      status: 'active',
    });
    return {
      ok: true,
      message: 'Family invitation accepted.',
      data: {
        relationship: relationshipJson(rowsAfter[0], scopes, null, actorUserId),
      },
    };
  } catch (err) {
    try { await connection.rollback(); } catch (_) {}
    if (err?.code === 'ER_DUP_ENTRY') {
      return error('FAMILY_RELATIONSHIP_ALREADY_ACTIVE', 'This family relationship is already active.');
    }
    throw err;
  } finally {
    connection.release();
  }
}

export async function declineFamilyInvitation({ pool, actorUserId, invitationId }) {
  if (!idPattern.test(String(invitationId || ''))) {
    return error('INVALID_FAMILY_INVITATION_ID', 'Invalid family invitation ID.');
  }
  const invitation = await readInvitation(pool, invitationId);
  if (!invitation || String(invitation.caregiver_user_id) !== String(actorUserId)) {
    return error('FAMILY_INVITATION_NOT_FOUND', 'Family invitation not found.');
  }
  if (invitation.status !== 'pending') {
    return error('FAMILY_INVITATION_NOT_PENDING', 'This family invitation is not pending.');
  }
  await pool.execute(
    `UPDATE family_invitations
     SET status = 'declined', declined_at = CURRENT_TIMESTAMP
     WHERE id = ? AND caregiver_user_id = ? AND status = 'pending'`,
    [invitationId, actorUserId],
  );
  await recordFamilyAudit({
    db: pool,
    actorUserId,
    careRecipientUserId: invitation.care_recipient_user_id,
    caregiverUserId: invitation.caregiver_user_id,
    invitationId,
    eventType: 'invitation_declined',
  });
  return {
    ok: true,
    message: 'Family invitation declined.',
    data: { invitation: { ...invitationJson(invitation), status: 'declined' } },
  };
}

export async function updateFamilyPermissions({ pool, actorUserId, relationshipId, scopes }) {
  const authorized = await authorizeFamilyAccess({
    pool,
    actorUserId,
    relationshipId,
  });
  if (!authorized.ok) return authorized;
  if (authorized.data.role !== 'care_recipient') {
    return error('FAMILY_PERMISSION_MANAGE_DENIED', 'Only the care recipient can change family permissions.');
  }
  const patch = normalizeScopePatch(scopes);
  if (!patch) {
    return error('INVALID_FAMILY_PERMISSION_SCOPE', 'Choose valid family permission scopes.');
  }
  for (const [scope, allowed] of Object.entries(patch)) {
    await pool.execute(
      `INSERT INTO family_permissions (
        relationship_id, scope, allowed, updated_by_user_id
       ) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        allowed = VALUES(allowed),
        updated_by_user_id = VALUES(updated_by_user_id)`,
      [relationshipId, scope, allowed ? 1 : 0, actorUserId],
    );
  }
  await recordFamilyAudit({
    db: pool,
    actorUserId,
    careRecipientUserId: authorized.data.relationship.care_recipient_user_id,
    caregiverUserId: authorized.data.relationship.caregiver_user_id,
    relationshipId,
    eventType: 'permission_changed',
    metadata: { scopes: patch },
  });
  const permissions = await readFamilyPermissions(pool, relationshipId);
  return {
    ok: true,
    message: 'Family permissions updated.',
    data: {
      relationship: relationshipJson(
        authorized.data.relationship,
        permissions,
        null,
        actorUserId,
      ),
    },
  };
}

export async function revokeFamilyRelationship({ pool, actorUserId, relationshipId }) {
  const authorized = await authorizeFamilyAccess({
    pool,
    actorUserId,
    relationshipId,
  });
  if (!authorized.ok) return authorized;
  await pool.execute(
    `UPDATE family_relationships
     SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'active'
       AND (care_recipient_user_id = ? OR caregiver_user_id = ?)`,
    [relationshipId, actorUserId, actorUserId],
  );
  await recordFamilyAudit({
    db: pool,
    actorUserId,
    careRecipientUserId: authorized.data.relationship.care_recipient_user_id,
    caregiverUserId: authorized.data.relationship.caregiver_user_id,
    relationshipId,
    eventType: 'relationship_revoked',
  });
  return { ok: true, message: 'Family access revoked.', data: {} };
}

function sectionBlocked(scope) {
  return { allowed: false, requiredScope: scope };
}

function sectionAllowed(scope, data) {
  return { allowed: true, requiredScope: scope, ...data };
}

async function primaryPlanId(pool, targetUserId) {
  const plans = await listCarePlans({ pool, userId: targetUserId });
  if (!plans.ok) return null;
  return plans.data.plans.find((plan) => plan.status === 'active')?.id ||
    plans.data.plans[0]?.id ||
    null;
}

export async function readFamilyMemberSummary({
  pool,
  actorUserId,
  relationshipId,
  compact = false,
  today = null,
}) {
  const access = await authorizeFamilyAccess({
    pool,
    actorUserId,
    relationshipId,
  });
  if (!access.ok) return access;
  const { relationship, permissions, targetUserId } = access.data;
  const summary = {};
  const clientToday = taskOutcomeDate(today);

  if (permissions['care_plan.read'] || access.data.role === 'care_recipient') {
    const plans = await listCarePlans({ pool, userId: targetUserId });
    if (plans.ok) {
      summary.carePlans = sectionAllowed('care_plan.read', {
        activeCount: plans.data.plans.filter((plan) => plan.status === 'active').length,
        totalCount: plans.data.plans.length,
        items: compact ? [] : plans.data.plans,
      });
    }
  } else {
    summary.carePlans = sectionBlocked('care_plan.read');
  }

  if (permissions['task.read'] || access.data.role === 'care_recipient') {
    const todayState = await readTodayTasksState({
      pool,
      userId: targetUserId,
      date: clientToday,
      today: clientToday,
    });
    if (todayState.ok) {
      summary.today = sectionAllowed('task.read', {
        date: todayState.data.date,
        taskSummary: todayState.data.summary,
        nextTask: nextTaskFromTodayState(todayState.data),
        occurrences: compact ? [] : todayState.data.occurrences,
      });
    }
  } else {
    summary.today = sectionBlocked('task.read');
  }

  if (permissions['care_gap.read'] || access.data.role === 'care_recipient') {
    const plans = await listCarePlans({ pool, userId: targetUserId });
    const gaps = [];
    let aggregate = { total: 0, open: 0, blocking: 0, attention: 0, inProgress: 0, resolved: 0 };
    if (plans.ok) {
      for (const plan of plans.data.plans.slice(0, compact ? 4 : 20)) {
        const gapResult = await listCareGaps({ pool, userId: targetUserId, planId: plan.id });
        if (!gapResult.ok) continue;
        aggregate = {
          total: aggregate.total + Number(gapResult.data.summary.total || 0),
          open: aggregate.open + Number(gapResult.data.summary.open || 0),
          blocking: aggregate.blocking + Number(gapResult.data.summary.blocking || 0),
          attention: aggregate.attention + Number(gapResult.data.summary.attention || 0),
          inProgress: aggregate.inProgress + Number(gapResult.data.summary.inProgress || 0),
          resolved: aggregate.resolved + Number(gapResult.data.summary.resolved || 0),
        };
        if (!compact) gaps.push(...gapResult.data.gaps.map((gap) => ({ ...gap, planTitle: plan.title })));
      }
    }
    summary.careGaps = sectionAllowed('care_gap.read', {
      summary: aggregate,
      items: gaps,
    });
  } else {
    summary.careGaps = sectionBlocked('care_gap.read');
  }

  if (permissions['simulation.read'] || access.data.role === 'care_recipient') {
    const planId = await primaryPlanId(pool, targetUserId);
    if (planId) {
      const simulation = await readSimulationState({ pool, userId: targetUserId, planId });
      if (simulation.ok) {
        summary.simulation = sectionAllowed('simulation.read', {
          planId,
          readiness: simulation.data.readiness,
          activationAllowed: simulation.data.activationAllowed,
          hardBlockerCount: simulation.data.hardBlockerCount,
          metrics: simulation.data.metrics,
          findings: compact ? [] : simulation.data.findings,
        });
      }
    } else {
      summary.simulation = sectionAllowed('simulation.read', { planId: null });
    }
  } else {
    summary.simulation = sectionBlocked('simulation.read');
  }

  if (permissions['performance.read'] || access.data.role === 'care_recipient') {
    const performance = await readPerformanceSummary({
      pool,
      userId: targetUserId,
      today: clientToday,
    });
    if (performance.ok) {
      summary.performance = sectionAllowed('performance.read', compact
        ? {
            date: performance.data.date,
            today: performance.data.today,
            primaryPlan: performance.data.primaryPlan,
          }
        : performance.data);
    }
  } else {
    summary.performance = sectionBlocked('performance.read');
  }

  const todaySummary = summary.today?.allowed ? summary.today.taskSummary : null;
  const openCareGaps = summary.careGaps?.allowed
    ? Number(summary.careGaps.summary?.open || 0)
    : null;
  const needsAttention = openCareGaps != null && openCareGaps > 0;
  const pending = todaySummary ? Number(todaySummary.pending || 0) + Number(todaySummary.missed || 0) : 0;
  const statusText = needsAttention || pending > 0 ? 'Needs attention' : 'On track';

  return {
    ok: true,
    data: {
      relationship: relationshipJson(relationship, permissions, null, actorUserId),
      summary: {
        statusText,
        ...summary,
      },
    },
  };
}

export async function readFamilyCarePlans({ pool, actorUserId, relationshipId }) {
  const access = await authorizeFamilyAccess({ pool, actorUserId, relationshipId, scope: 'care_plan.read' });
  if (!access.ok) return access;
  const result = await listCarePlans({ pool, userId: access.data.targetUserId });
  return result.ok ? { ok: true, data: result.data } : result;
}

export async function readFamilyCarePlanDetail({
  pool,
  actorUserId,
  relationshipId,
  planId,
}) {
  if (!idPattern.test(String(planId || ''))) {
    return error('INVALID_PLAN_ID', 'Invalid care plan ID.');
  }

  const access = await authorizeFamilyAccess({
    pool,
    actorUserId,
    relationshipId,
    scope: 'care_plan.read',
  });
  if (!access.ok) return access;

  const scheduleAllowed =
    access.data.role === 'care_recipient' ||
    access.data.permissions['schedule.read'] === true;

  const [plans] = await pool.execute(
    `SELECT care_plans.*,
      (SELECT COUNT(*) FROM care_documents
        WHERE care_documents.care_plan_id = care_plans.id) AS document_count,
      (SELECT COUNT(*) FROM care_schedule_items
        WHERE care_schedule_items.care_plan_id = care_plans.id) AS task_count,
      (SELECT COUNT(*) FROM care_gaps
        WHERE care_gaps.care_plan_id = care_plans.id
          AND care_gaps.status <> 'resolved') AS open_gap_count
     FROM care_plans
     WHERE care_plans.id = ? AND care_plans.user_id = ?
     LIMIT 1`,
    [String(planId), access.data.targetUserId],
  );
  if (plans.length === 0) {
    return error('PLAN_NOT_FOUND', 'Care plan not found.');
  }

  const [instructions] = await pool.execute(
    `SELECT id, document_id, category, title, instruction, timing,
      original_title, original_instruction, original_timing,
      duplicate_of_instruction_id, duplicate_reason,
      source_page, confidence_score, review_status,
      requires_professional_confirmation, ambiguity_reason,
      possible_interpretation, safety_note, safety_check_status,
      safety_check_summary, safety_possible_interpretation,
      safety_question, safety_sources,
      safety_checked_at, verified_at
     FROM extracted_instructions
     WHERE care_plan_id = ? AND review_status = 'verified'
     ORDER BY id`,
    [String(planId)],
  );

  let tasks = [];
  if (scheduleAllowed) {
    const [taskRows] = await pool.execute(
      `SELECT id, instruction_id, NULL AS caregiver_id,
        schedule_date AS task_date, schedule_date, schedule_time,
        COALESCE(TIME_FORMAT(schedule_time, '%H:%i'), NULLIF(display_time, ''), 'Review timing') AS task_time,
        title,
        CONCAT_WS(
          ' · ',
          NULLIF(recurrence_text, ''),
          NULLIF(display_time, ''),
          NULLIF(reason, '')
        ) AS note,
        task_kind, display_time, recurrence_text, grounding,
        recurrence_mode, recurrence_weekdays_json,
        recurrence_interval_days, recurrence_month_days_json,
        recurrence_source,
        CASE
          WHEN grounding = 'explicit' AND schedule_time IS NOT NULL THEN 1
          ELSE 0
        END AS time_locked,
        instruction_duration_days,
        COALESCE(
          NULLIF(instruction_duration_source, ''),
          CASE
            WHEN instruction_duration_days IS NOT NULL THEN 'verified'
            ELSE NULL
          END
        ) AS instruction_duration_source,
        CASE WHEN requires_confirmation = 1 THEN 'at_risk' ELSE 'ready' END AS status,
        NULL AS completed_at
       FROM care_schedule_items
       WHERE care_plan_id = ? AND user_id = ?
       ORDER BY schedule_date, schedule_time, id`,
      [String(planId), access.data.targetUserId],
    );
    tasks = taskRows.map(familyScheduleTaskJson);
  }

  return {
    ok: true,
    data: {
      relationship: relationshipJson(
        access.data.relationship,
        access.data.permissions,
        null,
        actorUserId,
      ),
      plan: carePlanJson(plans[0]),
      instructions: instructions
        .filter((item) =>
          cleanText(item.title, 160) &&
          cleanText(item.instruction, 4000))
        .map(familyInstructionJson),
      tasks,
      schedule: {
        allowed: scheduleAllowed,
        requiredScope: 'schedule.read',
      },
      readOnly: true,
    },
  };
}

export async function readFamilyTodayTasks({
  pool,
  actorUserId,
  relationshipId,
  date = null,
  today = null,
}) {
  const access = await authorizeFamilyAccess({ pool, actorUserId, relationshipId, scope: 'task.read' });
  if (!access.ok) return access;
  const clientToday = taskOutcomeDate(today);
  const requestedDate = taskOutcomeDate(date);
  const result = await readTodayTasksState({
    pool,
    userId: access.data.targetUserId,
    date: requestedDate || clientToday,
    today: clientToday,
  });
  return result.ok ? { ok: true, data: result.data } : result;
}

export async function readFamilyCareGaps({ pool, actorUserId, relationshipId }) {
  const access = await authorizeFamilyAccess({ pool, actorUserId, relationshipId, scope: 'care_gap.read' });
  if (!access.ok) return access;
  const plans = await listCarePlans({ pool, userId: access.data.targetUserId });
  if (!plans.ok) return plans;
  const gaps = [];
  let summary = { total: 0, open: 0, blocking: 0, attention: 0, inProgress: 0, resolved: 0 };
  for (const plan of plans.data.plans) {
    const result = await listCareGaps({ pool, userId: access.data.targetUserId, planId: plan.id });
    if (!result.ok) continue;
    summary = {
      total: summary.total + Number(result.data.summary.total || 0),
      open: summary.open + Number(result.data.summary.open || 0),
      blocking: summary.blocking + Number(result.data.summary.blocking || 0),
      attention: summary.attention + Number(result.data.summary.attention || 0),
      inProgress: summary.inProgress + Number(result.data.summary.inProgress || 0),
      resolved: summary.resolved + Number(result.data.summary.resolved || 0),
    };
    gaps.push(...result.data.gaps.map((gap) => ({ ...gap, planTitle: plan.title })));
  }
  return { ok: true, data: { summary, gaps } };
}

export async function readFamilySimulation({ pool, actorUserId, relationshipId, planId = null }) {
  const access = await authorizeFamilyAccess({ pool, actorUserId, relationshipId, scope: 'simulation.read' });
  if (!access.ok) return access;
  const resolvedPlanId = idPattern.test(String(planId || ''))
    ? String(planId)
    : await primaryPlanId(pool, access.data.targetUserId);
  if (!resolvedPlanId) {
    return { ok: true, data: { planId: null, simulation: null } };
  }
  const result = await readSimulationState({
    pool,
    userId: access.data.targetUserId,
    planId: resolvedPlanId,
  });
  return result.ok ? { ok: true, data: { planId: resolvedPlanId, simulation: result.data } } : result;
}

export async function readFamilyPerformance({
  pool,
  actorUserId,
  relationshipId,
  today = null,
}) {
  const access = await authorizeFamilyAccess({ pool, actorUserId, relationshipId, scope: 'performance.read' });
  if (!access.ok) return access;
  return readPerformanceSummary({
    pool,
    userId: access.data.targetUserId,
    today: taskOutcomeDate(today),
  });
}
