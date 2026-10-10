import {randomUUID} from 'node:crypto';
import {validateCarePlanTitle} from '../services/care_plan_title_service.js';
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const closed=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const statuses=['collecting','awaiting_confirmation','completed','cancelled'];
const fail=code=>({ok:false,code});

export function validateTaskWorkflow(raw) {
 if(!closed(raw,['workflowId','kind','revision','status','fields','awaitingField','confirmationId','expiresAt','completedReceipt'])||!token(raw.workflowId)||raw.kind!=='create_care_plan'||!Number.isInteger(raw.revision)||raw.revision<1||raw.revision>10000||!statuses.includes(raw.status)||!closed(raw.fields,['title']))return null;
 if(raw.fields.title!==undefined&&(typeof raw.fields.title!=='string'||!validateCarePlanTitle(raw.fields.title).ok||validateCarePlanTitle(raw.fields.title).title!==raw.fields.title))return null;
 if(raw.awaitingField!==undefined&&raw.awaitingField!=='title')return null;
 if(raw.confirmationId!==undefined&&!token(raw.confirmationId))return null;
 if(raw.expiresAt!==undefined&&(typeof raw.expiresAt!=='string'||raw.expiresAt.length>40||!Number.isFinite(Date.parse(raw.expiresAt))))return null;
 if(raw.status==='collecting'&&(raw.awaitingField!=='title'||raw.confirmationId!==undefined||raw.fields.title!==undefined))return null;
 if(raw.status==='awaiting_confirmation'&&(!raw.fields.title||!raw.confirmationId||!raw.expiresAt||raw.completedReceipt!==undefined))return null;
 if(raw.status==='completed'&&(!closed(raw.completedReceipt,['confirmationId','planId','title'])||!token(raw.completedReceipt.confirmationId)||raw.completedReceipt.confirmationId!==raw.confirmationId||!/^\d{1,20}$/.test(raw.completedReceipt.planId)||raw.completedReceipt.title!==raw.fields.title))return null;
 if(raw.status!=='completed'&&raw.completedReceipt!==undefined)return null;
 if(Buffer.byteLength(JSON.stringify(raw))>2048)return null;
 return structuredClone(raw);
}

export function validateTaskCommand(command) {
 if(!closed(command,['kind','workflowKind','fieldSpans'])||!['start','update','resume','cancel'].includes(command.kind))return false;
 if(command.kind==='start'&&command.workflowKind!=='create_care_plan')return false;
 if(command.kind!=='start'&&command.workflowKind!==undefined)return false;
 if(command.fieldSpans!==undefined&&(!closed(command.fieldSpans,['title'])||!closed(command.fieldSpans.title,['start','end'])||!Number.isInteger(command.fieldSpans.title.start)||!Number.isInteger(command.fieldSpans.title.end)))return false;
 if(['resume','cancel'].includes(command.kind)&&command.fieldSpans!==undefined)return false;
 return command.kind!=='update'||command.fieldSpans!==undefined;
}

export function taskWorkflowText(key,language,title='') {
 const texts={
  name:{en:'What name should I give the care plan?',ur:'کیئر پلان کا کیا نام رکھوں؟',roman_ur:'Care plan ka naam kya rakhoon?'},
  continue:{en:'Go ahead. First, what name should I give the care plan?',ur:'جی، بتاتے جائیں۔ پہلے کیئر پلان کا نام بتا دیں۔',roman_ur:'Theek hai, aap batate jayein. Pehle care plan ka naam bata dein.'},
  confirm:{en:`Create a draft care plan named “${title}”?`,ur:`“${title}” نام کا ڈرافٹ کیئر پلان بناؤں؟`,roman_ur:`“${title}” naam ka draft care plan bana doon?`},
  done:{en:`The draft care plan “${title}” was created. Upload its documents next.`,ur:`ڈرافٹ کیئر پلان “${title}” بن گیا۔ اب اس کے دستاویزات اپ لوڈ کریں۔`,roman_ur:`Draft care plan “${title}” ban gaya. Ab is ke documents upload karein.`},
  cancelled:{en:'Care plan creation cancelled.',ur:'کیئر پلان بنانا منسوخ کر دیا۔',roman_ur:'Care plan banana cancel kar diya.'},
  invalid:{en:'Please use a care plan name with 2–80 characters.',ur:'کیئر پلان کا نام ۲ سے ۸۰ حروف کا رکھیں۔',roman_ur:'Care plan ka naam 2 se 80 haroof ka rakhein.'},
  failed:{en:'The care plan could not be created. Nothing has been confirmed as saved.',ur:'کیئر پلان نہیں بن سکا۔ محفوظ ہونے کی تصدیق نہیں ہوئی۔',roman_ur:'Care plan nahi ban saka. Save hone ki tasdeeq nahi hui.'},
  duplicate:{en:'A care plan with that name already exists. Choose another name.',ur:'اس نام کا کیئر پلان پہلے سے موجود ہے۔ دوسرا نام منتخب کریں۔',roman_ur:'Is naam ka care plan pehle se mojood hai. Doosra naam dein.'},
 };
 return texts[key]?.[language]??texts[key]?.en;
}

export function taskWorkflowResponse(workflow,language) {
 const confirmation=workflow.status==='awaiting_confirmation'?{confirmationId:workflow.confirmationId,kind:'create_care_plan',message:taskWorkflowText('confirm',language,workflow.fields.title),expiresAt:workflow.expiresAt}:null;
 return {taskWorkflow:workflow,confirmation,clarification:null,actionStatus:workflow.status==='awaiting_confirmation'?'awaiting_confirmation':workflow.status==='completed'?'confirmed':workflow.status==='cancelled'?'cancelled':null,
 reply:taskWorkflowText(workflow.status==='collecting'?'name':workflow.status==='completed'?'done':workflow.status==='cancelled'?'cancelled':'confirm',language,workflow.fields.title),
 navigation:workflow.status==='completed'?{target:'care_plan_upload',params:{carePlanId:workflow.completedReceipt.planId}}:null,referencedEntities:[]};
}

export function reduceTaskWorkflow({current=null,command,message='',language='en',now=new Date()}) {
 if(!validateTaskCommand(command))return fail('AGENT_TASK_COMMAND_INVALID');
 const previous=current==null?null:validateTaskWorkflow(current);
 if(current!=null&&!previous)return fail('AGENT_TASK_WORKFLOW_INVALID');
 let workflow=previous;
 if(command.kind==='start') {
  if(workflow&&['collecting','awaiting_confirmation'].includes(workflow.status))return {ok:true,workflow,...taskWorkflowResponse(workflow,language)};
  workflow={workflowId:randomUUID(),kind:'create_care_plan',revision:1,status:'collecting',fields:{},awaitingField:'title'};
 } else if(!workflow||!['collecting','awaiting_confirmation'].includes(workflow.status))return fail('AGENT_TASK_NOT_ACTIVE');
 if(command.kind==='cancel')workflow={workflowId:workflow.workflowId,kind:workflow.kind,revision:workflow.revision+1,status:'cancelled',fields:workflow.fields};
 if(command.fieldSpans!==undefined) {
  const {start,end}=command.fieldSpans.title;
  if(typeof message!=='string'||start<0||end<=start||end>message.length)return fail('AGENT_TASK_SOURCE_INVALID');
  const title=validateCarePlanTitle(message.slice(start,end));
  if(!title.ok)return {...fail(title.code),reply:taskWorkflowText('invalid',language)};
  workflow={workflowId:workflow.workflowId,kind:workflow.kind,revision:workflow.revision+1,status:'awaiting_confirmation',fields:{title:title.title},confirmationId:randomUUID(),expiresAt:new Date(now.getTime()+600000).toISOString()};
 }
 return {ok:true,workflow,...taskWorkflowResponse(workflow,language)};
}

// The server's one outstanding slot is stronger context than generic ambiguity.
// Spans always refer to the original message; presentation never supplies fields.
export function pendingTitleCommand(workflow,message,plan) {
 if(workflow?.status!=='collecting'||workflow.awaitingField!=='title')return null;
 if(plan?.taskCommand||plan?.languageCommand||plan?.memoryProposal)return null;
 if(plan&&(!['conversation','ambiguous'].includes(plan.category)||plan.taskInput==='continuation'||plan.taskInput==='change_topic'||/acknowledg|continuation|collection_ack/.test(plan.intent)))return null;
 const raw=String(message);
 const prefix=/^\s*(?:if\s+)?(?:the\s+)?(?:name(?:\s+of\s+(?:the\s+)?care\s+plan)?|care\s+plan\s+name|title)\s*(?:is|:|=)\s*/i.exec(raw);
 const start=prefix?prefix[0].length:raw.length-raw.trimStart().length;
 const end=raw.trimEnd().length;
 const title=raw.slice(start,end);
 // Clear questions/commands cannot be silently collected when model is uncertain.
 if(!prefix&&(/[?؟]/u.test(title)||/^(?:please\s+)?(?:cancel|stop|don't|do not|change|switch|open|show|explain|help|delete|remove|save|confirm|yes|no)\b/i.test(title)))return null;
 if(!validateCarePlanTitle(title).ok)return null;
 return {kind:'update',fieldSpans:{title:{start,end}}};
}
