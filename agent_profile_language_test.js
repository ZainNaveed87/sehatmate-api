import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readProfileLanguage,voiceLanguageProfile} from './agent/agent_profile_language.js';

test('profile language reader scopes its existing field query to the authenticated owner',async()=>{
  const db={execute:async(sql,params)=>{
    assert.equal(sql,'SELECT preferred_language FROM patient_profiles WHERE user_id = ? LIMIT 1');
    assert.deepEqual(params,['42']);
    return [[{preferred_language:'Roman Urdu'}]];
  }};
  assert.equal(await readProfileLanguage(db,'42'),'roman_ur');
});

test('one canonical profile mapping separates recognition from reply preference',()=>{
  for(const [value,language,sttLanguage] of [['English','en','en'],['en','en','en'],
    ['Urdu','ur','ur'],['ur','ur','ur'],['Roman Urdu','roman_ur','ur'],['roman_ur','roman_ur','ur'],
    [null,'en','en'],['unknown','en','en']]) {
    assert.deepEqual(voiceLanguageProfile(value),{language,sttLanguage});
  }
});

test('profile read errors propagate instead of using stale conversation language',async()=>{
  await assert.rejects(readProfileLanguage({execute:async()=>{throw new Error('read unavailable');}},'42'));
});
