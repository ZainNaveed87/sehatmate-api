import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAgentMessage} from './agent/agent_core.js';
import {createAgentProvider} from './agent/agent_provider.js';
import {emptyAgentSessionState} from './agent/agent_session_state.js';
import {CopilotTestDb} from './agent_copilot_test_db.js';
import {createAgentMemory,readRelevantAgentMemory} from './agent/agent_memory.js';
import {mountAgentCopilotRoutes} from './agent/agent_copilot_routes.js';
import {sanitizeAgentSessionState} from './agent/agent_session_state.js';
process.env.AGENT_ENABLED='true';

// Only the external SQL/model boundaries are doubled. Real session CAS,
// confirmation claim, validation, transaction and read-back code are exercised.
class Database extends CopilotTestDb {
 constructor(){super();this.state=emptyAgentSessionState();this.language='English';this.tail=Promise.resolve();}
 async execute(sql,args=[]){
  sql=sql.replace(/\s+/g,' ').trim();
  if(sql.includes('SELECT preferred_language'))return [[{preferred_language:this.language}]];
  if(sql.startsWith('SELECT id, user_id')&&sql.includes('FROM agent_sessions'))return [[{id:11,user_id:1,language:'en',state_json:JSON.stringify(this.state),expires_at:'2099-01-01'}]];
  if(sql.startsWith('UPDATE agent_sessions')){
   if(sql.includes('state_json = ?')){
    if(args.length===4&&args[3]!==JSON.stringify(this.state))return [{affectedRows:0}];
    this.state=JSON.parse(args[0]);
   }
   return [{affectedRows:1}];
  }
  if(sql.startsWith('INSERT INTO agent_memory')&&this.writeError)throw Object.assign(new Error('PRIVATE_BODY'),{code:this.writeError});
  if(sql.startsWith('SELECT * FROM agent_memory WHERE id = ?')&&this.readBackMissing)return [[]];
  if(sql.startsWith('SELECT * FROM agent_memory WHERE id = ?')&&this.readBackWrong)return [[{...this.memory[0],value_json:'{"name":"Zain"}'}]];
  if(sql.startsWith('SELECT * FROM agent_memory WHERE id = ?')&&this.readBackError)throw Object.assign(new Error('PRIVATE_READ'),{code:this.readBackError});
  if(/agent_memory|agent_copilot_|SELECT id FROM users|SELECT id FROM agent_sessions/.test(sql))return super.execute(sql,args);
  if(sql.startsWith('SELECT'))return [[]];
  if(sql.startsWith('INSERT'))return [{affectedRows:1,insertId:1}];
  throw new Error('Unexpected personal-memory test query');
 }
 async getConnection(){
  let release;const prior=this.tail;this.tail=new Promise(r=>release=r);
  return {execute:this.execute.bind(this),beginTransaction:async()=>{await prior;await this.beginTransaction();},
   commit:async()=>{if(this.commitError)throw Object.assign(new Error('PRIVATE_COMMIT'),{code:this.commitError});await this.commit();},
   rollback:this.rollback.bind(this),release};
 }
}
const plan=command=>({category:'memory',intent:'personal_memory',capabilityCalls:[],memoryCommand:command});
function nameRequest(name='Zane',preferred=false){
 const message=`My ${preferred?'preferred ':''}name is ${name}. Add it to your memory.`;
 return {message,plan:plan({kind:'remember',nameSpan:{start:message.indexOf(name),end:message.indexOf(name)+name.length},requestSpan:{start:message.indexOf('Add'),end:message.length}})};
}
async function turn(db,{message,plan:semantic,confirmation,screen='upload_documents',voiceReply=false}){
 const provider=createAgentProvider({generateJson:async args=>{
  assert.ok(!confirmation,'confirmation must not ask a model for consent');
  return {json:args.systemPrompt.includes('planning stage')?semantic:{messageTemplate:'A neutral answer.'}};
 }});
 return handleAgentMessage({pool:db,userId:'1',sessionId:'11',message,confirmation,clientContext:{screenId:screen},provider,voiceReply});
}
const decide=(db,confirmationId,decision='confirm')=>turn(db,{confirmation:{confirmationId,decision}});
const writes=db=>db.calls.filter(c=>c.sql.startsWith('INSERT INTO agent_memory')).length;

for(const [name,preferred] of [['Zane',false],['Zen',true],['Zain',false]])test(`exact ${preferred?'preferred ':''}name ${name} requires confirmation before any write`,async()=>{
 const db=new Database();const r=await turn(db,nameRequest(name,preferred));
 assert.equal(r.actionStatus,'awaiting_confirmation');assert.equal(r.confirmation.kind,'personal_memory');
 assert.ok(r.reply.includes(name));assert.ok(r.confirmation.message.includes(name));assert.equal(writes(db),0);
 assert.equal(db.memory.length,0);assert.equal(r.memoryProposal,undefined);
 const saved=await decide(db,r.confirmation.confirmationId);
 assert.equal(saved.actionStatus,'confirmed');assert.equal(saved.memoryReceipt.status,'succeeded');
 assert.equal(writes(db),1);assert.deepEqual(JSON.parse(db.memory[0].value_json),{name});assert.ok(saved.reply.includes(name));
});
for(const message of ['yes','confirm','no'])test(`spoken ${message} resolves the server pending operation`,async()=>{
 const db=new Database();await turn(db,nameRequest());const r=await turn(db,{message,voiceReply:true});
 assert.equal(r.actionStatus,message==='no'?'cancelled':'confirmed');assert.equal(writes(db),message==='no'?0:1);
 assert.equal(db.state.pendingConfirmation,null);assert.equal(db.state.pendingDraft,null);
});
test('button cancel consumes the same pending operation without a write',async()=>{
 const db=new Database();const r=await turn(db,nameRequest());const cancelled=await decide(db,r.confirmation.confirmationId,'cancel');
 assert.equal(cancelled.actionStatus,'cancelled');assert.equal(writes(db),0);
});
test('duplicate concurrent confirmations and later replay execute at most once',async()=>{
 const db=new Database();const r=await turn(db,nameRequest());const id=r.confirmation.confirmationId;
 const results=await Promise.all([decide(db,id),decide(db,id)]);await decide(db,id);
 assert.equal(results.filter(r=>r.memoryReceipt?.status==='succeeded').length,1);assert.equal(writes(db),1);assert.equal(db.memory.length,1);
});
test('new personal request cannot replace an unresolved candidate; stale ID cannot execute a newer candidate',async()=>{
 const db=new Database();const first=await turn(db,nameRequest('Zane'));
 const blocked=await turn(db,nameRequest('Zain'));assert.equal(blocked.confirmation.confirmationId,first.confirmation.confirmationId);
 assert.ok(blocked.confirmation.message.includes('Zane'));await decide(db,first.confirmation.confirmationId,'cancel');
 const next=await turn(db,nameRequest('Zen',true));const stale=await decide(db,first.confirmation.confirmationId);
 assert.equal(stale.actionStatus,'rejected');assert.equal(writes(db),0);assert.equal(db.state.pendingConfirmation.confirmationId,next.confirmation.confirmationId);
 await decide(db,next.confirmation.confirmationId);assert.deepEqual(JSON.parse(db.memory[0].value_json),{name:'Zen'});
});
for(const code of ['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR','ETIMEDOUT'])test(`confirmed write ${code} remains an honest failure`,async()=>{
 const db=new Database();const r=await turn(db,nameRequest());db.writeError=code;
 const failed=await decide(db,r.confirmation.confirmationId);assert.equal(failed.actionStatus,'rejected');
 assert.notEqual(failed.memoryReceipt.status,'succeeded');assert.match(failed.reply,/could not save/i);assert.equal(db.memory.length,0);
});
test('ambiguous commit cannot produce a success receipt',async()=>{
 const db=new Database();const r=await turn(db,nameRequest());db.commitError='ETIMEDOUT';
 const failed=await decide(db,r.confirmation.confirmationId);assert.notEqual(failed.memoryReceipt.status,'succeeded');assert.match(failed.reply,/could not save/i);
});
test('committed write with missing read-back cannot claim definite success or retry the write',async()=>{
 const db=new Database();const r=await turn(db,nameRequest());db.readBackMissing=true;
 const failed=await decide(db,r.confirmation.confirmationId);assert.notEqual(failed.memoryReceipt.status,'succeeded');
 assert.equal(failed.fallbackCode,'AGENT_MEMORY_VERIFICATION_FAILED');assert.match(failed.reply,/could not save|could not verify/i);
 await decide(db,r.confirmation.confirmationId);assert.equal(writes(db),1);
});
test('storage service requires account-scoped read-back and returns the stored value',async()=>{
 const db=new Database();const item={kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'brief'},source:'user_confirmation',confirmedByUser:true,evidenceRef:'test:confirm'};
 const receipt=await createAgentMemory({db,userId:'1',item,evidence:{explicitUser:true,ref:item.evidenceRef}});
 assert.equal(receipt.ok,true);assert.deepEqual(receipt.memory.value,{level:'brief'});
 assert.ok(db.calls.some(c=>c.sql.startsWith('SELECT * FROM agent_memory WHERE id = ?')&&c.params[1]==='1'));
 const other=await readRelevantAgentMemory({db,userId:'2',review:true});assert.equal(other.length,0);
});
for(const proposal of [
 {kind:'USER_PREFERENCE',key:'communication.language',value:{language:'roman_ur'}},
 {kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'brief'}},
])test(`existing ${proposal.key} proposals use the same pending server operation`,async()=>{
 const db=new Database();const r=await turn(db,{message:'Remember this preference.',plan:{category:'conversation',intent:'preference',capabilityCalls:[],memoryProposal:proposal}});
 assert.equal(r.confirmation.kind,'personal_memory');assert.equal(r.memoryProposal,undefined);assert.equal(writes(db),0);
 assert.ok(r.confirmation.message.includes(Object.values(proposal.value)[0]));
 await decide(db,r.confirmation.confirmationId);assert.deepEqual(JSON.parse(db.memory[0].value_json),proposal.value);
});
for(const screen of ['upload_documents','care_plan_details','tasks','settings'])test(`name recall is account-level on ${screen}`,async()=>{
 const db=new Database();const r=await turn(db,nameRequest());await decide(db,r.confirmation.confirmationId);
 const recalled=await turn(db,{message:"do you know what's my name",plan:plan({kind:'recall'}),screen});
 assert.match(recalled.reply,/Zane/);assert.doesNotMatch(recalled.reply,/from this screen|access to personal/i);
 assert.equal(recalled.memoryReceipt.status,'found');
});
test('absent account memory is honest, but missing schema is an unavailable read',async()=>{
 const db=new Database();const req={message:"what's my name",plan:plan({kind:'recall'})};
 assert.match((await turn(db,req)).reply,/no saved name|not.*saved/i);
 db.missingSchema=true;const failed=await turn(db,req);assert.equal(failed.memoryReceipt.status,'failed');assert.match(failed.reply,/could not read/i);
});
test('Memory review endpoint reads the same stored account item and reports schema failure',async()=>{
 const db=new Database();const r=await turn(db,nameRequest());await decide(db,r.confirmation.confirmationId);
 const routes=new Map();const app={};for(const method of ['get','post','delete'])app[method]=(path,...handlers)=>routes.set(`${method}:${path}`,handlers.at(-1));
 mountAgentCopilotRoutes({app,pool:db,authenticate:()=>{},validateContext:()=>({ok:true})});
 const handler=routes.get('get:/api/agent/copilot/memory');let body,status=200;const res={set(){},status(code){status=code;return this;},json(value){body=value;return this;}};
 await handler({auth:{userId:'1'}},res);assert.deepEqual(body.data[0].value,{name:'Zane'});
 await handler({auth:{userId:'1'}},res);assert.equal(body.data.length,1);
 db.missingSchema=true;await handler({auth:{userId:'1'}},res);assert.equal(status,503);assert.equal(body.success,false);
});
test('confirmation and recall maintain selected Roman Urdu authority',async()=>{
 const db=new Database();db.language='Roman Urdu';const r=await turn(db,nameRequest());
 assert.doesNotMatch(r.reply,/[\u0600-\u06ff]/u);assert.match(r.reply,/Zane/);
 const saved=await decide(db,r.confirmation.confirmationId);assert.doesNotMatch(saved.reply,/[\u0600-\u06ff]/u);
 const recalled=await turn(db,{message:"what's my name",plan:plan({kind:'recall'})});assert.doesNotMatch(recalled.reply,/[\u0600-\u06ff]/u);assert.match(recalled.reply,/Zane/);
});
test('preference recall uses the requested supported key across routes',async()=>{
 const db=new Database();const proposal={kind:'USER_PREFERENCE',key:'explanation.detail',value:{level:'step_by_step'}};
 const r=await turn(db,{message:'Remember my explanation preference.',plan:{category:'conversation',intent:'preference',capabilityCalls:[],memoryProposal:proposal}});
 await decide(db,r.confirmation.confirmationId);
 const recalled=await turn(db,{message:'What explanation style do you remember?',plan:plan({kind:'recall',key:'explanation.detail'}),screen:'upload_documents'});
 assert.equal(recalled.memoryReceipt.key,'explanation.detail');assert.equal(recalled.memoryReceipt.status,'found');assert.match(recalled.reply,/step_by_step/);
});
test('wrong read-back value and unavailable read-back are never successful',async()=>{
 for(const field of ['readBackWrong','readBackError']) {
  const db=new Database();const r=await turn(db,nameRequest());db[field]=field==='readBackWrong'?true:'ER_NO_SUCH_TABLE';
  const failed=await decide(db,r.confirmation.confirmationId);assert.notEqual(failed.memoryReceipt.status,'succeeded');assert.equal(failed.actionStatus,'rejected');assert.equal(writes(db),1);
 }
});
test('expired pending memory cannot write and a new candidate stays exact',async()=>{
 const db=new Database();const r=await turn(db,nameRequest());db.state.pendingDraft.expiresAt=db.state.pendingConfirmation.expiresAt='2000-01-01';
 assert.equal((await decide(db,r.confirmation.confirmationId)).actionStatus,'rejected');assert.equal(writes(db),0);
 const next=await turn(db,nameRequest('Zen'));await decide(db,next.confirmation.confirmationId);assert.deepEqual(JSON.parse(db.memory[0].value_json),{name:'Zen'});
});
test('ordinary context and unsupported clinical memory never persist',async()=>{
 for(const semantic of [{category:'conversation',intent:'chat',capabilityCalls:[]},{category:'conversation',intent:'memory',capabilityCalls:[],memoryProposal:{kind:'CONFIRMED_FACT',key:'diagnosis',value:{diagnosis:'x'}}}]) {
  const db=new Database();await turn(db,{message:'Just talking about today.',plan:semantic});assert.equal(writes(db),0);assert.equal(db.state.pendingConfirmation,null);
 }
});
test('bounded confirmation state preserves the exact candidate string instead of normalizing it',()=>{
 const item={kind:'CONFIRMED_FACT',key:'identity.name',value:{name:'Zane  Ali'}};
 const state=sanitizeAgentSessionState({...emptyAgentSessionState(),pendingDraft:{kind:'personal_memory',toolName:'agent_personal_memory',confirmationId:'test-confirm',expiresAt:'2099-01-01',memoryItem:JSON.stringify(item)}});
 assert.equal(state.ok,true);assert.deepEqual(JSON.parse(state.state.pendingDraft.memoryItem),item);
});
