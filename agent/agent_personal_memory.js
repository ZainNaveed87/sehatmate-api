import {validateAgentMemoryProposal,agentNameMemoryReply} from './agent_memory.js';

// A view of the existing server pendingDraft, not a second confirmation store.
export function personalMemoryItem(draft) {
 if(draft?.kind!=='personal_memory'||draft.toolName!=='agent_personal_memory')return null;
 try {
  const item=JSON.parse(draft.memoryItem);
  const valid=validateAgentMemoryProposal(item);
  return valid.ok?valid.proposal:null;
 } catch {return null;}
}
export function personalMemoryText(item,language,status='pending') {
 if(item.key==='identity.name') {
  if(status==='succeeded'||status==='failed')return agentNameMemoryReply({language,operation:'remember',status,name:item.value.name});
  if(status==='verification_failed')return {en:'I could not verify that your name was saved in Agent Memory. Please check Agent Memory before trying again.',roman_ur:'Aap ka naam Agent Memory mein save hone ki tasdeeq nahi ho saki. Dobara koshish se pehle Agent Memory check karein.',ur:'آپ کا نام Agent Memory میں محفوظ ہونے کی تصدیق نہیں ہو سکی۔ دوبارہ کوشش سے پہلے Agent Memory دیکھیں۔'}[language];
  return {en:`Your name is ${item.value.name}. Do you want me to save that in Agent Memory?`,roman_ur:`Aap ka naam ${item.value.name} hai. Kya ise Agent Memory mein save kar doon?`,ur:`آپ کا نام ${item.value.name} ہے۔ کیا اسے Agent Memory میں محفوظ کر دوں؟`}[language];
 }
 // Closed schema keys and exact canonical candidate values, never model prose.
 const candidate=JSON.stringify(item.value);
 if(status==='succeeded')return {en:`I've saved your preference in Agent Memory: ${candidate}.`,roman_ur:`Aap ki preference Agent Memory mein save ho gayi hai: ${candidate}.`,ur:`آپ کی ترجیح Agent Memory میں محفوظ ہو گئی ہے: ${candidate}۔`}[language];
 if(status==='failed'||status==='verification_failed')return {en:status==='verification_failed'?'I could not verify that the preference was saved. Please check Agent Memory before trying again.':'I could not save your preference in Agent Memory. Please try again.',roman_ur:'Aap ki preference Agent Memory mein save hone ki tasdeeq nahi ho saki.',ur:'آپ کی ترجیح Agent Memory میں محفوظ ہونے کی تصدیق نہیں ہو سکی۔'}[language];
 return {en:`Your preference (${item.key}) is ${candidate}. Do you want me to save that in Agent Memory?`,roman_ur:`Aap ki preference (${item.key}) ${candidate} hai. Kya ise Agent Memory mein save kar doon?`,ur:`آپ کی ترجیح (${item.key}) ${candidate} ہے۔ کیا اسے Agent Memory میں محفوظ کر دوں؟`}[language];
}
export function personalMemoryConfirmation(draft,language) {
 const item=personalMemoryItem(draft);
 return item?{confirmationId:draft.confirmationId,kind:'personal_memory',expiresAt:draft.expiresAt,message:personalMemoryText(item,language)}:null;
}
