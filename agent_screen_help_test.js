import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentReplyPrompts} from './agent/agent_response_grounder.js';
test('zero-tool screen explanations keep only registered UI evidence',()=>{
 const prompt=buildAgentReplyPrompts({language:'roman_ur',message:'Explain this screen',category:'ambiguous',contextSlice:{clientUi:{screenId:'settings',route:'settings',version:'test:1',entities:[],actions:[],targets:[{id:'settings.language',kind:'control',label:'Language'}]},patientPrivate:'must disappear'},capabilityResults:[]});
 assert.match(prompt.userPrompt,/settings.language/);assert.doesNotMatch(prompt.userPrompt,/must disappear/);
});
