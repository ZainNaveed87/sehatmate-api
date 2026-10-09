import {createCarePlan,validateCarePlanTitle} from '../services/care_plan_title_service.js';
import {defineAgentCapability,executeConfirmedAgentCapability} from './agent_capability_registry.js';
import {reviewAgentConfirmedCapabilityCall} from './agent_safety_gateway.js';
import {parseAgentSessionState,sanitizeAgentSessionState,serializeAgentSessionState} from './agent_session_state.js';
import {validateTaskWorkflow} from './agent_task_workflow.js';
import {agentConfig} from './agent_config.js';

defineAgentCapability({name:'create_care_plan',permissionClass:'REVERSIBLE_USER_ACTION',description:'Create a named draft care plan only after explicit owned workflow confirmation.',inputSchema:{properties:{title:{type:'care_plan_title'}},required:['title']},resultContract:'Committed draft plan ID/title; documents are collected separately.',execute:({pool,userId,args})=>createCarePlan({db:pool,userId,title:args.title})});

export async function executeConfirmedTaskWorkflow({pool,userId,sessionId,confirmationId,workflowId,revision,now=new Date()}) {
 if(!/^\d{1,20}$/.test(String(userId))||!/^\d{1,20}$/.test(String(sessionId))||typeof confirmationId!=='string'||confirmationId.length>80||!workflowId||!Number.isInteger(revision))return {ok:false,code:'AGENT_TASK_CONFIRMATION_INVALID'};
 const connection=await pool.getConnection();let committed=false;
 try {
  await connection.beginTransaction();
  const [rows]=await connection.execute('SELECT state_json FROM agent_sessions WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1 FOR UPDATE',[sessionId,userId]);
  if(!rows.length)return {ok:false,code:'AGENT_SESSION_NOT_FOUND'};
  const state=parseAgentSessionState(rows[0].state_json,{maxStateBytes:agentConfig().sessionStateMaxBytes});const task=validateTaskWorkflow(state.taskWorkflow);
  if(!task||task.workflowId!==workflowId||task.revision!==revision)return {ok:false,code:'AGENT_TASK_STALE_CONFIRMATION'};
  if(task.status==='completed'&&task.completedReceipt.confirmationId===confirmationId) {await connection.commit();committed=true;return {ok:true,workflow:task,replayed:true};}
  if(task.status!=='awaiting_confirmation'||task.confirmationId!==confirmationId||Date.parse(task.expiresAt)<=now.getTime())return {ok:false,code:'AGENT_TASK_STALE_CONFIRMATION'};
  if(!validateCarePlanTitle(task.fields.title).ok)return {ok:false,code:'INVALID_PLAN_TITLE'};
  const pendingDraft={toolName:'create_care_plan',confirmationId};
  if(!reviewAgentConfirmedCapabilityCall({name:'create_care_plan',pendingDraft}).ok)return {ok:false,code:'AGENT_CONFIRMATION_REQUIRED'};
  const result=await executeConfirmedAgentCapability({name:'create_care_plan',pool:connection,userId,args:{title:task.fields.title}});
  const plan=result?.data?.plan;
  if(!result.ok||!plan||!/^\d{1,20}$/.test(String(plan.id))||String(plan.user_id)!==String(userId)||plan.title!==task.fields.title)return {ok:false,code:result.code||'AGENT_TASK_CREATE_FAILED'};
  const workflow={...task,status:'completed',completedReceipt:{confirmationId,planId:String(plan.id),title:task.fields.title}};
  const checked=sanitizeAgentSessionState({...state,taskWorkflow:workflow},{maxStateBytes:agentConfig().sessionStateMaxBytes});
  if(!checked.ok)return checked;
  const [saved]=await connection.execute('UPDATE agent_sessions SET state_json = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP',[serializeAgentSessionState(checked.state),sessionId,userId]);
  if(saved.affectedRows!==1)return {ok:false,code:'AGENT_TASK_PERSISTENCE_FAILED'};
  await connection.commit();committed=true;return {ok:true,workflow,replayed:false};
 } finally {try{if(!committed)await connection.rollback();}finally{connection.release();}}
}
