function clean(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function normalizeTime(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function eventWeight(eventType) {
  switch (eventType) {
    case 'manual_schedule_edit':
      return 4;
    case 'manual_period_edit':
      return 3;
    case 'suggestion_accepted':
      return 3;
    case 'suggestion_rejected':
      return -3;
    case 'reality_answer':
      return 2;
    case 'task_completed':
      return 2;
    case 'task_missed':
      return -1;
    case 'caregiver_availability':
      return 2;
    default:
      return 1;
  }
}

function emptyLearnedPeriod() {
  return {
    preferredTime: null,
    confidence: 'No pattern yet',
    signalCount: 0,
    reason: 'SehatMate has not learned a stable time for this period yet.',
  };
}

function humanSignalReason(counts) {
  const parts = [];
  const push = (key, singular, plural = `${singular}s`) => {
    const count = Number(counts[key] || 0);
    if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
  };
  push('manual_schedule_edit', 'manual timing choice');
  push('suggestion_accepted', 'accepted suggestion');
  push('reality_answer', 'Reality Check signal');
  push('task_completed', 'successful reminder');
  push('suggestion_rejected', 'rejected suggestion');
  push('task_missed', 'missed reminder');

  if (!parts.length) {
    return 'Based on your recent routine activity.';
  }
  if (parts.length === 1) return `Based on ${parts[0]}.`;
  return `Based on ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}.`;
}

export async function ensureRoutineLearningSchema(db) {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS user_routine_profiles (
      user_id BIGINT UNSIGNED NOT NULL,
      learning_enabled TINYINT(1) NOT NULL DEFAULT 1,
      preferred_reminder_style VARCHAR(40) NOT NULL DEFAULT 'Balanced',
      morning_note VARCHAR(500) NULL,
      afternoon_note VARCHAR(500) NULL,
      evening_note VARCHAR(500) NULL,
      night_note VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT user_routine_profiles_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await db.execute(
    `CREATE TABLE IF NOT EXISTS routine_learning_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      care_plan_id BIGINT UNSIGNED NULL,
      event_type VARCHAR(60) NOT NULL,
      period VARCHAR(20) NULL,
      schedule_time TIME NULL,
      signal_value VARCHAR(500) NULL,
      source_key VARCHAR(180) NULL,
      weight DECIMAL(6,2) NOT NULL DEFAULT 1,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY routine_learning_source_unique (user_id, source_key),
      KEY routine_learning_user_period_idx (user_id, period, created_at),
      KEY routine_learning_plan_idx (care_plan_id),
      CONSTRAINT routine_learning_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT routine_learning_plan_fk
        FOREIGN KEY (care_plan_id) REFERENCES care_plans (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function ensureProfileRow(db, userId) {
  await db.execute(
    `INSERT INTO user_routine_profiles (user_id)
     VALUES (?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [userId],
  );
}

export async function recordRoutineLearningEvent({
  db,
  userId,
  carePlanId = null,
  eventType,
  period = null,
  scheduleTime = null,
  signalValue = null,
  sourceKey = null,
  metadata = null,
}) {
  await ensureProfileRow(db, userId);

  const [profiles] = await db.execute(
    `SELECT learning_enabled
     FROM user_routine_profiles
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  if (!profiles.length || !Boolean(profiles[0].learning_enabled)) {
    return false;
  }

  const safeEventType = clean(eventType, 60);
  const safePeriod = ['morning', 'afternoon', 'evening', 'night'].includes(period)
    ? period
    : null;
  const safeTime = normalizeTime(scheduleTime);
  const safeSignal = clean(signalValue, 500) || null;
  const safeSourceKey = clean(sourceKey, 180) || null;
  const weight = eventWeight(safeEventType);
  const metadataJson = metadata ? JSON.stringify(metadata).slice(0, 4000) : null;

  await db.execute(
    `INSERT INTO routine_learning_events (
       user_id, care_plan_id, event_type, period, schedule_time,
       signal_value, source_key, weight, metadata_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       care_plan_id = VALUES(care_plan_id),
       event_type = VALUES(event_type),
       period = VALUES(period),
       schedule_time = VALUES(schedule_time),
       signal_value = VALUES(signal_value),
       weight = VALUES(weight),
       metadata_json = VALUES(metadata_json),
       created_at = CURRENT_TIMESTAMP`,
    [
      userId,
      carePlanId,
      safeEventType,
      safePeriod,
      safeTime,
      safeSignal,
      safeSourceKey,
      weight,
      metadataJson,
    ],
  );
  return true;
}

export async function readRoutineProfile(db, userId) {
  await ensureProfileRow(db, userId);

  const [profiles] = await db.execute(
    `SELECT learning_enabled, preferred_reminder_style,
       morning_note, afternoon_note, evening_note, night_note
     FROM user_routine_profiles
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );

  const profile = profiles[0] || {};
  const [events] = await db.execute(
    `SELECT event_type, period,
       TIME_FORMAT(schedule_time, '%H:%i') AS schedule_time,
       signal_value, weight, created_at
     FROM routine_learning_events
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 300`,
    [userId],
  );

  const periods = ['morning', 'afternoon', 'evening', 'night'];
  const learned = {};
  for (const period of periods) {
    const relevant = events.filter((item) => item.period === period);
    if (!relevant.length) {
      learned[period] = emptyLearnedPeriod();
      continue;
    }

    const scoreByTime = new Map();
    const counts = {};
    for (const event of relevant) {
      counts[event.event_type] = Number(counts[event.event_type] || 0) + 1;
      const time = normalizeTime(event.schedule_time);
      if (!time) continue;
      const next = Number(scoreByTime.get(time) || 0) + Number(event.weight || 0);
      scoreByTime.set(time, next);
    }

    const ranked = [...scoreByTime.entries()]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);

    if (!ranked.length) {
      learned[period] = {
        preferredTime: null,
        confidence: 'Still learning',
        signalCount: relevant.length,
        reason: humanSignalReason(counts),
      };
      continue;
    }

    const [preferredTime, score] = ranked[0];
    learned[period] = {
      preferredTime,
      confidence: score >= 8 ? 'Strong' : score >= 4 ? 'Growing' : 'Early',
      signalCount: relevant.length,
      reason: humanSignalReason(counts),
    };
  }

  return {
    learningEnabled: profile.learning_enabled == null
      ? true
      : Boolean(profile.learning_enabled),
    preferredReminderStyle: profile.preferred_reminder_style || 'Balanced',
    notes: {
      morning: profile.morning_note || '',
      afternoon: profile.afternoon_note || '',
      evening: profile.evening_note || '',
      night: profile.night_note || '',
    },
    learned,
    totalSignals: events.length,
  };
}

export async function updateRoutineProfile(db, userId, input = {}) {
  await ensureProfileRow(db, userId);

  const allowedStyles = new Set(['Gentle', 'Balanced', 'Persistent']);
  const reminderStyle = allowedStyles.has(input.preferredReminderStyle)
    ? input.preferredReminderStyle
    : 'Balanced';

  await db.execute(
    `UPDATE user_routine_profiles
     SET learning_enabled = ?,
         preferred_reminder_style = ?,
         morning_note = ?,
         afternoon_note = ?,
         evening_note = ?,
         night_note = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [
      input.learningEnabled === false ? 0 : 1,
      reminderStyle,
      clean(input.notes?.morning, 500) || null,
      clean(input.notes?.afternoon, 500) || null,
      clean(input.notes?.evening, 500) || null,
      clean(input.notes?.night, 500) || null,
      userId,
    ],
  );

  return readRoutineProfile(db, userId);
}

export async function resetRoutineLearning(db, userId) {
  await db.execute(
    'DELETE FROM routine_learning_events WHERE user_id = ?',
    [userId],
  );
  return readRoutineProfile(db, userId);
}
