import {randomUUID} from 'node:crypto';
import {resolveAgentNavigationTarget} from './agent_navigation_registry.js';

const token = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
const fields = (value,keys) => object(value) && Object.keys(value).every(k=>keys.includes(k));
const fail = code => ({ok:false,code});
const kinds = new Set(['read_current_screen','read_section','read_selection','highlight','focus','scroll_to','open_section','expand','collapse','select_option','next','previous','navigate_to_registered_route','open_entity']);
const targetKinds = new Set(['section','question','option','control','button','entity','field','navigation']);
export const AGENT_UI_LIMITS = Object.freeze({snapshotBytes:4096,targets:20,actions:20,operations:4});

export function validateCopilotClientContext(raw) {
  if(!fields(raw,['screenId','entity','ui'])) return fail('AGENT_UI_INVALID_CONTEXT');
  const checked=validateAgentUiContext(raw.ui);
  if(!checked.ok||raw.screenId!==checked.context.screenId) return fail('AGENT_UI_INVALID_CONTEXT');
  if(raw.entity!=null&&(!fields(raw.entity,['type','id'])||!['care_plan','care_gap','family_member'].includes(raw.entity.type)||
    typeof raw.entity.id!=='string'||!/^\d{1,20}$/.test(raw.entity.id))) return fail('AGENT_UI_INVALID_ENTITY');
  if(Buffer.byteLength(JSON.stringify(raw))>4096) return fail('AGENT_UI_CONTEXT_TOO_LARGE');
  return {ok:true,context:JSON.parse(JSON.stringify(raw))};
}

// These describe UI state only. They never authorize a backend patient-data write.
export function validateAgentUiContext(raw) {
  if(!fields(raw,['screenId','route','version','focusedSectionId','entities','targets','actions'])) return fail('AGENT_UI_INVALID_CONTEXT');
  if(!resolveAgentNavigationTarget(raw.screenId)||!resolveAgentNavigationTarget(raw.route)||!token(raw.version)) return fail('AGENT_UI_INVALID_CONTEXT');
  if(!Array.isArray(raw.targets)||raw.targets.length>20||!Array.isArray(raw.actions)||raw.actions.length>20||
    !Array.isArray(raw.entities)||raw.entities.length>6) return fail('AGENT_UI_INVALID_CONTEXT');
  if(Buffer.byteLength(JSON.stringify(raw))>AGENT_UI_LIMITS.snapshotBytes) return fail('AGENT_UI_CONTEXT_TOO_LARGE');
  const ids=new Set();
  for(const t of raw.targets) {
    if(!fields(t,['id','kind','label','selected'])||!token(t.id)||ids.has(t.id)||!targetKinds.has(t.kind)||
      typeof t.label!=='string'||t.label.length>480||/[\u0000-\u001f]/.test(t.label)||
      t.selected!==undefined&&typeof t.selected!=='boolean') return fail('AGENT_UI_INVALID_TARGET');
    ids.add(t.id);
    if(t.kind==='navigation') {
      const definition=t.id.startsWith('navigation.')&&resolveAgentNavigationTarget(t.id.slice('navigation.'.length));
      // Entity routes keep the existing backend ownership-authorized intent path.
      if(!definition||Object.values(definition.params).includes('required')) return fail('AGENT_UI_INVALID_TARGET');
    }
  }
  if(raw.focusedSectionId!=null&&!ids.has(raw.focusedSectionId)) return fail('AGENT_UI_UNKNOWN_TARGET');
  const actionIds=new Set();
  for(const a of raw.actions) {
    if(!fields(a,['id','kind','targetId'])||!token(a.id)||actionIds.has(a.id)||!kinds.has(a.kind)||!ids.has(a.targetId)) return fail('AGENT_UI_INVALID_ACTION');
    // Only the first complete, explicitly instrumented workflow offers writes.
    if(['select_option','next','previous'].includes(a.kind)&&raw.screenId!=='reality_check') return fail('AGENT_UI_ACTION_UNAVAILABLE');
    if(a.kind==='navigate_to_registered_route'&&raw.targets.find(t=>t.id===a.targetId).kind!=='navigation') return fail('AGENT_UI_INVALID_ACTION');
    // This callback uses the loaded, authenticated gap's closed actionType and
    // related plan/question. Model arguments never select a route or entity.
    if(a.kind==='open_entity'&&(!['care_gaps','care_gap_detail'].includes(raw.screenId)||!/^care_gaps\.card\.[1-9]\d{0,19}$/.test(a.targetId))) return fail('AGENT_UI_ACTION_UNAVAILABLE');
    actionIds.add(a.id);
  }
  for(const e of raw.entities) if(!fields(e,['type','id'])||!['care_plan','care_gap','family_member'].includes(e.type)||!token(e.id)) return fail('AGENT_UI_INVALID_ENTITY');
  return {ok:true,context:JSON.parse(JSON.stringify(raw))};
}

export function uiActionRiskTier(kind,screenId) {
  if(['read_current_screen','read_section','read_selection','highlight','focus','scroll_to'].includes(kind)) return 0;
  if(screenId==='reality_check'&&['select_option','next'].includes(kind)) return 2;
  return kinds.has(kind)?1:3;
}

export function validateAgentUiOperations(raw,context) {
  if(raw==null) raw=[];
  if(!Array.isArray(raw)||raw.length>AGENT_UI_LIMITS.operations) return fail('AGENT_UI_INVALID_OPERATION');
  if(!raw.length) return {ok:true,operations:[]};
  if(!validateAgentUiContext(context).ok) return fail('AGENT_UI_CONTEXT_REQUIRED');
  const operations=[];
  for(const op of raw) {
    if(!fields(op,['actionId','targetId','args'])||!token(op.actionId)||!token(op.targetId)||!fields(op.args??{},[]) ) return fail('AGENT_UI_INVALID_OPERATION');
    const action=context.actions.find(a=>a.id===op.actionId&&a.targetId===op.targetId);
    if(!action) return fail('AGENT_UI_ACTION_UNAVAILABLE');
    operations.push({actionId:op.actionId,targetId:op.targetId,args:{}});
  }
  return {ok:true,operations};
}

export function buildAgentUiPlan({context,operations}) {
  const checked=validateAgentUiOperations(operations,context);
  if(!checked.ok||!checked.operations.length) return null;
  return {id:randomUUID(),screenId:context.screenId,version:context.version,
    operations:checked.operations.map(op=>({...op,riskTier:uiActionRiskTier(context.actions.find(a=>a.id===op.actionId).kind,context.screenId)}))};
}
