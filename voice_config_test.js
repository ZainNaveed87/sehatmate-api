import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentVoiceProvider} from './agent/agent_voice_provider.js';

const module = await import('./agent/agent_voice_config.js').catch(() => ({}));
test('unconfigured voice fails closed without exposing credential material', () => {
  assert.equal(typeof module.voiceConfiguration, 'function');
  const config = module.voiceConfiguration({});
  assert.equal(config.enabled, false);
  assert.equal(config.providers.livekit, false);
});
test('invalid budgets and paid Fish models disable cloud functionality', () => {
  const config = module.voiceConfiguration({
    REALTIME_VOICE_ENABLED: 'true', LIVEKIT_URL: 'wss://test.livekit.cloud',
    LIVEKIT_API_KEY: 'mock-key', LIVEKIT_API_SECRET: 's'.repeat(40),
    VOICE_RECEIPT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    VOICE_WORKER_AUTH_KEY: 'w'.repeat(40), VOICE_DELEGATION_SECRET: 'd'.repeat(40),
    FISH_API_KEY: 'mock-fish', FISH_TTS_MODEL: 's2.1-pro',
    VOICE_MAX_SESSION_SECONDS: '-1',
  });
  assert.equal(config.enabled, false);
  assert.equal(config.providers.fish, false);
  assert.doesNotMatch(JSON.stringify(config), /ssssss|mock-key|mock-fish|dddddd/);
});
test('free Fish is the primary path for complete Agent replies without an account list', () => {
  const config = module.voiceConfiguration({FISH_API_KEY: 'mock', FISH_TTS_MODEL: 's2.1-pro-free'});
  assert.deepEqual(module.speechDisposition(config, {reply: 'Metformin 500 mg at 2 PM'}), {provider:'fish',model:'s2.1-pro-free',text:'Metformin 500 mg at 2 PM'});
  assert.equal(module.speechDisposition(config, {genericPrompt:'welcome'}).provider, 'fish');
  assert.equal(module.speechDisposition(config, {genericPrompt:'unknown'}).provider, 'device');
});
test('existing free Fish path preserves exact approved text while disabled and paid Fish never request',async()=>{
  const config={enabled:true,apiKey:'mock',ttsModel:'fish-audio/s2.1-pro-free:free',ttsVoice:'mock'};
  const requests=[];
  const provider=createAgentVoiceProvider({config:()=>config,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,arrayBuffer:async()=>Buffer.from('mock-audio')};}});
  const text='  Metformin 500 mg\n at 08:30. دوا  ';
  assert.equal((await provider.synthesizeApprovedReply({reply:text})).ok,true);
  assert.equal(requests[0].input,text);
  config.ttsModel='s2.1-pro-free';
  assert.equal((await provider.synthesizeApprovedReply({reply:text})).ok,true);
  config.fishDisabled=true;
  assert.equal((await provider.synthesizeApprovedReply({reply:'Welcome to SehatMate.'})).code,'VOICE_PRIVACY_DEVICE_REQUIRED');
  assert.equal(requests.length,2);
  config.fishDisabled=false;
  config.ttsModel='fish-audio/s2.1-pro';
  assert.equal((await provider.synthesizeApprovedReply({reply:'Welcome to SehatMate.'})).code,'VOICE_PRIVACY_DEVICE_REQUIRED');
});


test('every account receives bound Agent speech policy; global provider disable still applies', () => {
  const config=module.voiceConfiguration({FISH_API_KEY:'mock',FISH_TTS_MODEL:'s2.1-pro-free'});
  for(const userId of ['1','2','11']) assert.deepEqual(module.sessionSpeechPolicy(config,{id:'voice',epoch:3,userId}),{v:1,voiceSessionId:'voice',epoch:3,mode:'agent_reply',provider:'fish',model:'s2.1-pro-free'});
  assert.equal(config.policy.fishGenericOnly,false);
  assert.equal(module.sessionSpeechPolicy(module.voiceConfiguration({FISH_DISABLED:'true'}),{id:'voice',epoch:3,userId:'1'}).mode,'device_only');
});
