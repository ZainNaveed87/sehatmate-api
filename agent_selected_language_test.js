import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAgentTurnLanguage} from './agent/agent_turn_language.js';

for (const [selected,expected] of [['English','en'],['Urdu','ur'],['Roman Urdu','roman_ur']]) {
  for (const message of ['settings kholo','Show my care plans','سیٹنگز کھولو','haan']) {
    test(`selected ${expected} is authoritative for ${message}`,()=>{
      assert.equal(resolveAgentTurnLanguage({message,profileLanguage:selected,lastTurnLanguage:'en'}).language,expected);
    });
  }
}
