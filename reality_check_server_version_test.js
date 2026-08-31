import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

assert.match(
  server,
  /activeSet\.generatorVersion\s*!==\s*REALITY_CHECK_GENERATOR_VERSION/,
  'Server must refuse persisted Reality Check sets from an older generator safety version.',
);

assert.match(
  server,
  /if \(createIfMissing && tasks\.length > 0\)[\s\S]*?getOrCreateRealityQuestionSet/,
  'Reality Check GET path must always pass through the version-aware store resolver.',
);

assert.match(
  server,
  /activeSet\s*=\s*await getOrCreateRealityQuestionSet/,
  'The resolved set must replace the previously-read persisted set.',
);

console.log('Reality Check server generator-version integration test passed.');
