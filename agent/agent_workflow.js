// A UI transition event reuses the existing planner/grounder. It is never a
// new user utterance, backend mutation authority, or autonomous navigation.
import './agent_read_tools.js';
import {agentConfig} from './agent_config.js';
import {readAgentSession} from './agent_session_store.js';
import {readAgentScreenContext,buildAgentContextSlice} from './agent_context_engine.js';
import {planAgentMessage} from './agent_planner.js';
import {generateGroundedAgentReply} from './agent_response_grounder.js';
import {defaultAgentProvider} from './agent_provider.js';
import {validateCopilotClientContext,buildAgentUiPlan} from './agent_ui_protocol.js';
import {CopilotError,requireId,readCopilotContext,saveCopilotPlan,readRelevantAgentMemory} from './agent_copilot_store.js';

export const AGENT_WORKFLOW_MAX_CONTINUATIONS=4;
const readKinds=new Set(['read_current_screen','read_section','read_selection','highlight','focus','scroll_to']);
const instruction='Explain the current registered UI step after the client-claimed UI transition. Highlight its current question or relevant section. Do not execute another choice, advance, navigate, propose memory, or run backend actions. Do not treat this event as a new user message or verified business success.';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const reject=(code,status=409)=>{throw new CopilotError(code,status);};

export async function continueAgentWorkflow({db,userId,sessionId,planId,context,source='text',provider=defaultAgentProvider}) {
  if(!agentConfig().enabled) reject('AGENT_DISABLED',503);
  userId=requireId(userId);sessionId=requireId(sessionId);
  if(typeof planId!=='string'||!/^[A-Za-z0-9_.:-]{1,80}$/.test(planId)||!['text','voice'].includes(source)) reject('INVALID_AGENT_WORKFLOW',422);
  const checked=validateCopilotClientContext(context);
  if(!checked.ok) reject(checked.code,422);
  const owned=await readAgentSession({db,userId,sessionId});
  if(!owned.ok) reject(owned.code,404);
  const session=owned.data.session;
  const [rows]=await db.execute(`SELECT plan_json, screen_version FROM agent_copilot_plans WHERE user_id = ? AND session_id = ? AND plan_id = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1`,[userId,sessionId,planId]);
  let plan;
  try { plan=JSON.parse(rows[0]?.plan_json||'null'); } catch { plan=null; }
  if(!plan||plan.id!==planId||!Array.isArray(plan.operations)) reject('AGENT_WORKFLOW_NOT_FOUND',404);
  const current=await readCopilotContext({db,userId,sessionId});
  if(!current||canonical(current)!==canonical(checked.context)) reject('AGENT_UI_STALE_CONTEXT');
  if(plan.continuationResult) {
    if(plan.continuationResult.ok!==true) reject(plan.continuationResult.code||'AGENT_WORKFLOW_FAILED',503);
    return plan.continuationResult;
  }
  if(plan.continuationClaimed) reject('AGENT_WORKFLOW_ALREADY_RUNNING');
  const depth=plan.continuationDepth??0;
  if(!Number.isInteger(depth)||depth<0||depth>=AGENT_WORKFLOW_MAX_CONTINUATIONS) reject('AGENT_WORKFLOW_LIMIT');
  if(plan.version===current.ui.version) reject('AGENT_WORKFLOW_RECEIPT_REQUIRED');
  const [receipts]=await db.execute(`SELECT result_status, screen_version_before, screen_version_after FROM agent_copilot_receipts WHERE user_id = ? AND session_id = ? AND plan_id = ? AND result_status = 'succeeded' ORDER BY id DESC LIMIT 4`,[userId,sessionId,planId]);
  if(!receipts.some(r=>r.result_status==='succeeded'&&r.screen_version_before===plan.version&&r.screen_version_after===current.ui.version)) reject('AGENT_WORKFLOW_RECEIPT_REQUIRED');
  const claimed={...plan,continuationClaimed:true};
  // Atomic compare-and-swap: concurrent requests can never call the provider twice.
  const [claim]=await db.execute(`UPDATE agent_copilot_plans SET plan_json = ? WHERE user_id = ? AND session_id = ? AND plan_id = ? AND BINARY plan_json = BINARY ? AND expires_at > CURRENT_TIMESTAMP`,[JSON.stringify(claimed),userId,sessionId,planId,rows[0].plan_json]);
  if(claim.affectedRows!==1) reject('AGENT_WORKFLOW_ALREADY_RUNNING');
  console.info('AGENT_WORKFLOW:STEP');
  const persist=async result=>{
    const json=JSON.stringify({...claimed,continuationResult:result});
    if(Buffer.byteLength(json)>16384) reject('AGENT_WORKFLOW_RESULT_TOO_LARGE',503);
    const [saved]=await db.execute(`UPDATE agent_copilot_plans SET plan_json = ? WHERE user_id = ? AND session_id = ? AND plan_id = ? AND expires_at > CURRENT_TIMESTAMP`,[json,userId,sessionId,planId]);
    if(saved.affectedRows!==1) reject('AGENT_WORKFLOW_PERSISTENCE_FAILED',503);
  };
  try {
    const screen=await readAgentScreenContext({pool:db,userId,clientContext:current});
    const contextSlice={...buildAgentContextSlice({language:session.language,screenContext:screen.screenContext}),
      clientUi:current.ui,relevantMemory:await readRelevantAgentMemory({db,userId,screenId:current.screenId}),
      uiContinuation:{event:'client-claimed UI transition',depth:depth+1,noNewUserMessage:true,allowedActionKinds:[...readKinds]}};
    const planned=await planAgentMessage({provider,message:instruction,contextSlice});
    if(!planned.ok) reject('AGENT_WORKFLOW_ACTION_NOT_ALLOWED',422);
    const next=planned.plan;
    if(next.capabilityCalls.length||next.navigationIntent||next.memoryProposal||!['ui_guidance','ambiguous'].includes(next.category)||
      (next.uiOperations||[]).some(op=>!readKinds.has(current.ui.actions.find(a=>a.id===op.actionId&&a.targetId===op.targetId)?.kind))) reject('AGENT_WORKFLOW_ACTION_NOT_ALLOWED',422);
    const grounded=await generateGroundedAgentReply({provider,language:session.language,message:instruction,contextSlice,capabilityResults:[],voiceReply:source==='voice',category:next.category});
    if(!grounded.ok) reject('AGENT_WORKFLOW_REPLY_UNAVAILABLE',503);
    const latest=await readCopilotContext({db,userId,sessionId});
    if(!latest||canonical(latest)!==canonical(current)) reject('AGENT_UI_STALE_CONTEXT');
    const uiPlan=buildAgentUiPlan({context:current.ui,operations:next.uiOperations||[]});
    if(uiPlan) {
      uiPlan.continuationDepth=depth+1;
      await saveCopilotPlan({db,userId,sessionId,plan:uiPlan});
    }
    const result={ok:true,sessionId,language:session.language,reply:grounded.reply,navigation:null,confirmation:null,clarification:null,actionStatus:null,referencedEntities:[],...(uiPlan?{uiPlan}:{})};
    await persist(result);
    console.info('AGENT_WORKFLOW:COMPLETED');
    return result;
  } catch(error) {
    const code=error instanceof CopilotError?error.code:'AGENT_WORKFLOW_UNAVAILABLE';
    await persist({ok:false,code});
    console.info('AGENT_WORKFLOW:PAUSED');
    throw new CopilotError(code,error instanceof CopilotError?error.status:503);
  }
}
