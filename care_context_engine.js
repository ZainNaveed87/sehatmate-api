import {
  aiLanguageInstruction,
  normalizePreferredLanguage,
} from './language_support.js';

const ALLOWED_SIGNALS = new Set([
  'practical_support',
  'practical_constraint',
  'professional_guidance',
  'possible_instruction_change',
  'neutral',
]);

const ALLOWED_ACTIONS = new Set([
  'recheck_reality',
  'keep_at_risk',
  'review_verified_instruction',
  'no_change',
]);

const CARE_CONTEXT_TEXT = Object.freeze({
  English: Object.freeze({
    possibleInstructionChangeSummary:
      'A healthcare-professional response may affect the written care instruction. The existing verified instruction remains unchanged until the change is formally reviewed and verified.',
    possibleInstructionChangeQuestion:
      'Does this professional response require the verified care instruction to be formally updated?',
    professionalGuidanceSummary:
      'Healthcare-professional guidance has been recorded for this care gap.',
    professionalGuidanceQuestion:
      'With this professional guidance, is the current care task now practical to follow reliably?',
    userContextSummary:
      'New user-provided practical context has been recorded for this care gap.',
    userContextQuestion:
      'Has this new information changed how reliably the care task can be followed?',
    newContextRecorded:
      'New care-gap context was recorded.',
  }),
  Urdu: Object.freeze({
    possibleInstructionChangeSummary:
      'صحت کے پیشہ ور فرد کا جواب لکھی ہوئی دیکھ بھال کی ہدایت کو متاثر کر سکتا ہے۔ موجودہ تصدیق شدہ ہدایت اس وقت تک تبدیل نہیں ہو گی جب تک تبدیلی کا باقاعدہ جائزہ لے کر تصدیق نہ کر لی جائے۔',
    possibleInstructionChangeQuestion:
      'کیا اس پیشہ ورانہ جواب کی وجہ سے تصدیق شدہ دیکھ بھال کی ہدایت کو باقاعدہ اپ ڈیٹ کرنے کی ضرورت ہے؟',
    professionalGuidanceSummary:
      'اس دیکھ بھال کے خلا کے لیے صحت کے پیشہ ور فرد کی رہنمائی محفوظ کر دی گئی ہے۔',
    professionalGuidanceQuestion:
      'اس پیشہ ورانہ رہنمائی کے بعد، کیا موجودہ دیکھ بھال کا کام اب قابل اعتماد طریقے سے کرنا عملی ہے؟',
    userContextSummary:
      'اس دیکھ بھال کے خلا کے لیے صارف کی دی ہوئی عملی معلومات محفوظ کر دی گئی ہیں۔',
    userContextQuestion:
      'کیا اس نئی معلومات سے دیکھ بھال کے کام کو قابل اعتماد طریقے سے کرنے کی صورتحال بدلی ہے؟',
    newContextRecorded:
      'دیکھ بھال کے خلا کی نئی معلومات محفوظ کر دی گئی ہیں۔',
  }),
  'Roman Urdu': Object.freeze({
    possibleInstructionChangeSummary:
      'Healthcare-professional response likhi hui care instruction ko affect kar sakta hai. Maujooda verified instruction tab tak unchanged rahegi jab tak change ka formal review aur verification na ho.',
    possibleInstructionChangeQuestion:
      'Kya is professional response ki wajah se verified care instruction ko formally update karna zaroori hai?',
    professionalGuidanceSummary:
      'Is care gap ke liye healthcare-professional guidance record ho gayi hai.',
    professionalGuidanceQuestion:
      'Is professional guidance ke baad, kya current care task ab reliably follow karna practical hai?',
    userContextSummary:
      'Is care gap ke liye user-provided practical context record ho gaya hai.',
    userContextQuestion:
      'Kya is new information se care task ko reliably follow karne ki situation badli hai?',
    newContextRecorded:
      'Naya care-gap context record ho gaya hai.',
  }),
});

function careContextText(key, preferredLanguage) {
  const language = normalizePreferredLanguage(preferredLanguage);
  return CARE_CONTEXT_TEXT[language]?.[key] ||
    CARE_CONTEXT_TEXT.English[key] ||
    '';
}

function cleanContextText(
  value,
  maxLength = 2000,
) {
  return String(value ?? '')
    .replace(
      /[\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function parseAiJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed;
    }
  } catch (_) {
    // A deterministic safe fallback is used below.
  }

  return null;
}

function normalizeAnalysis(
  raw,
  fallbackSummary = '',
  preferredLanguage,
) {
  const signal = cleanContextText(
    raw?.signal,
    50,
  ).toLowerCase();

  const nextAction = cleanContextText(
    raw?.nextAction,
    60,
  ).toLowerCase();

  return {
    signal: ALLOWED_SIGNALS.has(signal)
      ? signal
      : 'neutral',

    summary:
      cleanContextText(
        raw?.summary,
        700,
      ) ||
      cleanContextText(
        fallbackSummary,
        700,
      ) ||
      careContextText(
        'newContextRecorded',
        preferredLanguage,
      ),

    nextAction:
      ALLOWED_ACTIONS.has(nextAction)
        ? nextAction
        : 'no_change',

    followUpQuestion:
      cleanContextText(
        raw?.followUpQuestion,
        700,
      ),

    requiresInstructionReview:
      raw?.requiresInstructionReview === true ||
      signal ===
        'possible_instruction_change',
  };
}

export function fallbackAnalysis({
  note,
  professionalAnswers,
  preferredLanguage,
}) {
  const combined = [
    cleanContextText(note),
    ...professionalAnswers.map(
      (item) =>
        cleanContextText(
          item.answer,
        ),
    ),
  ]
    .filter(Boolean)
    .join(' ');

  /*
   * Conservative fallback:
   * if a professional response appears to describe
   * changing treatment/timing, never apply it.
   * Send it to verified-instruction review instead.
   */
  const treatmentChangePattern =
    /\b(change|changed|switch|stop|stopped|discontinue|dose|dosage|frequency|instead|take at|move the time|new time|tabdeel|badal|rok|dawa|waqt|naya time|naya waqt)\b|(?:تبدیل|بدل|روک|خوراک|دوا|وقت|نیا وقت)/i;

  const possibleTreatmentChange =
    professionalAnswers.length > 0 &&
    treatmentChangePattern.test(combined);

  if (possibleTreatmentChange) {
    return {
      signal:
        'possible_instruction_change',

      summary:
        careContextText(
          'possibleInstructionChangeSummary',
          preferredLanguage,
        ),

      nextAction:
        'review_verified_instruction',

      followUpQuestion:
        careContextText(
          'possibleInstructionChangeQuestion',
          preferredLanguage,
        ),

      requiresInstructionReview: true,
    };
  }

  if (
    professionalAnswers.length > 0
  ) {
    return {
      signal:
        'professional_guidance',

      summary:
        careContextText(
          'professionalGuidanceSummary',
          preferredLanguage,
        ),

      nextAction:
        'recheck_reality',

      followUpQuestion:
        careContextText(
          'professionalGuidanceQuestion',
          preferredLanguage,
        ),

      requiresInstructionReview: false,
    };
  }

  if (
    cleanContextText(note)
  ) {
    return {
      signal: 'neutral',

      summary:
        careContextText(
          'userContextSummary',
          preferredLanguage,
        ),

      nextAction:
        'recheck_reality',

      followUpQuestion:
        careContextText(
          'userContextQuestion',
          preferredLanguage,
        ),

      requiresInstructionReview: false,
    };
  }

  return {
    signal: 'neutral',
    summary: '',
    nextAction: 'no_change',
    followUpQuestion: '',
    requiresInstructionReview: false,
  };
}

// =========================================================
// DATABASE SCHEMA
// =========================================================

export async function ensureCareContextSchema(
  db,
) {
  const [columns] =
    await db.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'care_gaps'
         AND COLUMN_NAME IN (
           'context_ai_signal',
           'context_ai_summary',
           'context_ai_next_action',
           'context_ai_follow_up_question',
           'context_ai_requires_instruction_review',
           'context_ai_updated_at'
         )`,
    );

  const names = new Set(
    columns.map(
      (item) =>
        item.COLUMN_NAME,
    ),
  );

  if (
    !names.has(
      'context_ai_signal',
    )
  ) {
    await db.execute(
      `ALTER TABLE care_gaps
       ADD COLUMN context_ai_signal
       VARCHAR(50) NULL`,
    );
  }

  if (
    !names.has(
      'context_ai_summary',
    )
  ) {
    await db.execute(
      `ALTER TABLE care_gaps
       ADD COLUMN context_ai_summary
       VARCHAR(700) NULL`,
    );
  }

  if (
    !names.has(
      'context_ai_next_action',
    )
  ) {
    await db.execute(
      `ALTER TABLE care_gaps
       ADD COLUMN context_ai_next_action
       VARCHAR(60) NULL`,
    );
  }

  if (
    !names.has(
      'context_ai_follow_up_question',
    )
  ) {
    await db.execute(
      `ALTER TABLE care_gaps
       ADD COLUMN context_ai_follow_up_question
       VARCHAR(700) NULL`,
    );
  }

  if (
    !names.has(
      'context_ai_requires_instruction_review',
    )
  ) {
    await db.execute(
      `ALTER TABLE care_gaps
       ADD COLUMN
       context_ai_requires_instruction_review
       TINYINT(1)
       NOT NULL DEFAULT 0`,
    );
  }

  if (
    !names.has(
      'context_ai_updated_at',
    )
  ) {
    await db.execute(
      `ALTER TABLE care_gaps
       ADD COLUMN context_ai_updated_at
       DATETIME NULL`,
    );
  }
}

// =========================================================
// ANALYZE + STORE CONTEXT
// =========================================================

export async function analyzeAndStoreCareGapContext({
  db,
  gapId,
  userId,
  generateAiText,
  preferredLanguage,
}) {
  const normalizedPreferredLanguage =
    normalizePreferredLanguage(preferredLanguage);
  const [gapRows] =
    await db.execute(
      `SELECT g.*
       FROM care_gaps g
       JOIN care_plans p
         ON p.id = g.care_plan_id
       WHERE g.id = ?
         AND p.user_id = ?
       LIMIT 1`,
      [
        gapId,
        userId,
      ],
    );

  const gap = gapRows[0];

  if (!gap) {
    return null;
  }

  const [professionalAnswers] =
    await db.execute(
      `SELECT
         id,
         question,
         answer,
         answered_at
       FROM doctor_questions
       WHERE care_gap_id = ?
         AND care_plan_id = ?
         AND status = 'answered'
         AND answer IS NOT NULL
         AND TRIM(answer) <> ''
       ORDER BY
         answered_at DESC,
         id DESC
       LIMIT 10`,
      [
        gapId,
        gap.care_plan_id,
      ],
    );

  const note =
    cleanContextText(
      gap.resolution_note,
      2000,
    );

  /*
   * No additional context exists.
   * Clear stale AI context if necessary.
   */
  if (
    !note &&
    professionalAnswers.length === 0
  ) {
    await db.execute(
      `UPDATE care_gaps
       SET
         context_ai_signal = NULL,
         context_ai_summary = NULL,
         context_ai_next_action = NULL,
         context_ai_follow_up_question = NULL,
         context_ai_requires_instruction_review = 0,
         context_ai_updated_at = NULL
       WHERE id = ?`,
      [gapId],
    );

    return null;
  }

  const fallback =
    fallbackAnalysis({
      note,
      professionalAnswers,
      preferredLanguage: normalizedPreferredLanguage,
    });

  let analysis = fallback;

  /*
   * AI analysis is fail-safe.
   *
   * If the provider is unavailable, the user's
   * note / professional response is still saved.
   * The deterministic fallback remains usable.
   */
  if (
    typeof generateAiText ===
    'function'
  ) {
    try {
      const result =
        await generateAiText({
          systemPrompt:
            `You are SehatRoute AI's practical care-context classifier.

You may interpret:
- routine feasibility
- access
- reminders
- caregiver or family support
- practical barriers
- practical support
- healthcare-professional responses

STRICT SAFETY RULES:

1. Never diagnose.
2. Never prescribe.
3. Never recommend a dose change.
4. Never recommend a medication change.
5. Never change treatment frequency.
6. Never change an explicit verified medical time.
7. Never mark a Care Gap resolved.
8. Never treat free-text as a replacement medical order.
9. A healthcare-professional response is context until any changed instruction is formally reviewed and verified.
10. If a professional response may change treatment, dose, frequency, or exact medical timing:
    signal = "possible_instruction_change"
    nextAction = "review_verified_instruction"
11. Practical improvement should normally use:
    nextAction = "recheck_reality"
because the user must confirm whether the task is now reliably achievable.
12. Apply the server-selected language only to summary and followUpQuestion.
13. Keep signal, nextAction and requiresInstructionReview as canonical machine values.
14. Keep user notes and healthcare-professional answers unchanged as source context. Never rewrite them as verified medical instructions.

Language rules:
${aiLanguageInstruction(normalizedPreferredLanguage, {
  scope: 'summary and followUpQuestion',
})}

Return JSON only.`,

          userPrompt:
            JSON.stringify(
              {
                allowedSignals: [
                  'practical_support',
                  'practical_constraint',
                  'professional_guidance',
                  'possible_instruction_change',
                  'neutral',
                ],

                allowedNextActions: [
                  'recheck_reality',
                  'keep_at_risk',
                  'review_verified_instruction',
                  'no_change',
                ],

                outputFormat: {
                  signal:
                    'one allowed signal',

                  summary:
                    'short practical summary',

                  nextAction:
                    'one allowed action',

                  followUpQuestion:
                    'one short question or empty string',

                  requiresInstructionReview:
                    'boolean',
                },

                careGap: {
                  title:
                    cleanContextText(
                      gap.title,
                      300,
                    ),

                  type:
                    cleanContextText(
                      gap.gap_type,
                      80,
                    ),

                  when:
                    cleanContextText(
                      gap.when_text,
                      160,
                    ),

                  currentProblem:
                    cleanContextText(
                      gap.summary,
                      1000,
                    ),

                  savedRealityAnswer:
                    cleanContextText(
                      gap.patient_reality,
                      1000,
                    ),

                  whyFlagged:
                    cleanContextText(
                      gap.reason,
                      1200,
                    ),

                  currentNextStep:
                    cleanContextText(
                      gap.next_step,
                      1200,
                    ),
                },

                newUserNote:
                  note || null,

                answeredProfessionalQuestions:
                  professionalAnswers.map(
                    (item) => ({
                      question:
                        cleanContextText(
                          item.question,
                          1200,
                        ),

                      answer:
                        cleanContextText(
                          item.answer,
                          2000,
                        ),
                    }),
                  ),
              },
              null,
              2,
            ),

          temperature: 0,
          maxTokens: 700,
          preferredLanguage: normalizedPreferredLanguage,
        });

      const parsed =
        parseAiJson(
          result?.text,
        );

      if (parsed) {
        analysis =
          normalizeAnalysis(
            parsed,
            fallback.summary,
            normalizedPreferredLanguage,
          );
      }
    } catch (error) {
      console.error(
        'Care-gap context AI analysis failed:',
        error?.message ||
          error,
      );
    }
  }

  await db.execute(
    `UPDATE care_gaps
     SET
       context_ai_signal = ?,
       context_ai_summary = ?,
       context_ai_next_action = ?,
       context_ai_follow_up_question = ?,
       context_ai_requires_instruction_review = ?,
       context_ai_updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      analysis.signal,

      analysis.summary ||
        null,

      analysis.nextAction,

      analysis.followUpQuestion ||
        null,

      analysis
          .requiresInstructionReview
        ? 1
        : 0,

      gapId,
    ],
  );

  return {
    gapId:
      String(gapId),

    carePlanId:
      String(
        gap.care_plan_id,
      ),

    ...analysis,
  };
}

// =========================================================
// READ CONTEXT FOR SIMULATION
// =========================================================

export async function readCareContextInsightsForPlan(
  db,
  planId,
) {
  const [rows] =
    await db.execute(
      `SELECT
         id AS gap_id,
         source_kind,
         source_id,
         context_ai_signal,
         context_ai_summary,
         context_ai_next_action,
         context_ai_follow_up_question,
         context_ai_requires_instruction_review,
         context_ai_updated_at
       FROM care_gaps
       WHERE care_plan_id = ?
         AND context_ai_summary
           IS NOT NULL
         AND TRIM(
           context_ai_summary
         ) <> ''
       ORDER BY
         context_ai_updated_at DESC,
         id DESC`,
      [planId],
    );

  return rows.map(
    (row) => ({
      gapId:
        String(
          row.gap_id,
        ),

      sourceKind:
        cleanContextText(
          row.source_kind,
          60,
        ),

      sourceId:
        cleanContextText(
          row.source_id,
          160,
        ),

      signal:
        ALLOWED_SIGNALS.has(
          cleanContextText(
            row.context_ai_signal,
            50,
          ).toLowerCase(),
        )
          ? cleanContextText(
              row.context_ai_signal,
              50,
            ).toLowerCase()
          : 'neutral',

      summary:
        cleanContextText(
          row.context_ai_summary,
          700,
        ),

      nextAction:
        ALLOWED_ACTIONS.has(
          cleanContextText(
            row.context_ai_next_action,
            60,
          ).toLowerCase(),
        )
          ? cleanContextText(
              row.context_ai_next_action,
              60,
            ).toLowerCase()
          : 'no_change',

      followUpQuestion:
        cleanContextText(
          row.context_ai_follow_up_question,
          700,
        ),

      requiresInstructionReview:
        Boolean(
          row
            .context_ai_requires_instruction_review,
        ),

      updatedAt:
        row.context_ai_updated_at ||
        null,
    }),
  );
}

// =========================================================
// USE CONTEXT IN SIMULATION
// =========================================================

export function enrichSimulationFindingsWithContext(
  findings,
  contextInsights,
) {
  const bySourceId =
    new Map();

  for (
    const insight of
    contextInsights || []
  ) {
    if (
      insight.sourceId &&
      !bySourceId.has(
        insight.sourceId,
      )
    ) {
      bySourceId.set(
        insight.sourceId,
        insight,
      );
    }
  }

  return (
    findings || []
  ).map(
    (finding) => {
      const key =
        cleanContextText(
          finding?.key,
          160,
        );

      const insight =
        key
          ? bySourceId.get(key)
          : null;

      if (!insight) {
        return finding;
      }

      /*
       * Important:
       * context NEVER creates an auto-applicable
       * medical change.
       */
      const base = {
        ...finding,

        canApply: false,

        contextInsight: {
          signal:
            insight.signal,

          summary:
            insight.summary,

          nextAction:
            insight.nextAction,

          followUpQuestion:
            insight
              .followUpQuestion,

          requiresInstructionReview:
            insight
              .requiresInstructionReview,
        },
      };

      // -----------------------------------------
      // Possible treatment/instruction change
      // -----------------------------------------

      if (
        insight
          .requiresInstructionReview ||
        insight.nextAction ===
          'review_verified_instruction'
      ) {
        return {
          ...base,

          recommendation:
            'A healthcare-professional response may affect the verified care instruction. Review and verify the instruction before applying any treatment or timing change. The current verified instruction remains unchanged.',

          action:
            'review_instruction',

          actionLabel:
            'Review verified instruction',
        };
      }

      // -----------------------------------------
      // New practical support/context
      // -----------------------------------------

      if (
        insight.nextAction ===
        'recheck_reality'
      ) {
        return {
          ...base,

          recommendation:
            `${insight.summary} Re-check the related Reality Check answer to confirm whether this task is now reliably achievable. The verified care instruction remains unchanged.`,

          action:
            'reality_check',

          actionLabel:
            'Re-check practical fit',
        };
      }

      // -----------------------------------------
      // Practical constraint remains
      // -----------------------------------------

      if (
        insight.nextAction ===
          'keep_at_risk' ||
        insight.signal ===
          'practical_constraint'
      ) {
        return {
          ...base,

          recommendation:
            `${insight.summary} Keep the current verified instruction unchanged and review practical access, reminders, or support.`,

          action:
            'reality_check',

          actionLabel:
            'Review practical support',
        };
      }

      return base;
    },
  );
}
