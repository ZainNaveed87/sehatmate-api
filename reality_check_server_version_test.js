import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const realityAnswerService = fs.readFileSync(
  new URL('./services/reality_answer_service.js', import.meta.url),
  'utf8',
);

// Since the Phase A service extraction, the generator-version safety gate
// lives in the authoritative reality answer service. Both the REST routes
// and any future agent tool must go through that single implementation.

assert.match(
  realityAnswerService,
  /activeSet\.generatorVersion\s*!==\s*REALITY_CHECK_GENERATOR_VERSION/,
  'The Reality Check service must refuse persisted sets from an older generator safety version.',
);

assert.match(
  realityAnswerService,
  /if \(createIfMissing && tasks\.length > 0\)[\s\S]*?getOrCreateRealityQuestionSet/,
  'Reality Check question resolution must always pass through the version-aware store resolver.',
);

assert.match(
  realityAnswerService,
  /activeSet\s*=\s*await getOrCreateRealityQuestionSet/,
  'The resolved set must replace the previously-read persisted set.',
);

// The REST layer must delegate to the same authoritative service instead of
// keeping a second implementation of the version gate.
assert.match(
  server,
  /realityDecisionTemplatesForPlan[\s\S]*?from\s+'\.\/services\/reality_answer_service\.js'/,
  'server.js must resolve Reality Check questions through the reality answer service.',
);

assert.doesNotMatch(
  server,
  /REALITY_CHECK_GENERATOR_VERSION/,
  'server.js must not duplicate the generator-version safety gate.',
);

console.log('Reality Check server generator-version integration test passed.');
