// Closed commands selected by the existing semantic planner. No profile writes
// occur here: app language uses the registered, confirmed Flutter setting action.
const languages=['en','ur','roman_ur'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function validateLanguageCommand(v) {
 if(!object(v)||Object.keys(v).some(k=>!['scope','language','options'].includes(k))||!['app','conversation'].includes(v.scope))return false;
 if(languages.includes(v.language))return v.options===undefined;
 return v.language===null&&Array.isArray(v.options)&&v.options.length>=1&&v.options.length<=3&&new Set(v.options).size===v.options.length&&v.options.every(l=>languages.includes(l));
}
export function validateConversationLanguage(v) {
 return object(v)&&Object.keys(v).every(k=>['language','profileLanguage'].includes(k))&&languages.includes(v.language)&&languages.includes(v.profileLanguage);
}
export function effectiveConversationLanguage(state,profile) {
 const value=state?.conversationLanguage;
 return validateConversationLanguage(value)&&value.profileLanguage===profile?value.language:profile;
}
const labels={en:'English',ur:'Urdu',roman_ur:'Roman Urdu'};
export function languageQuestionText(options,language) {
 const names=options.map(l=>labels[l]);
 return language==='ur'?`${names.join(' یا ')}؟`:language==='roman_ur'?`${names.join(' ya ')}?`:`${names.join(' or ')}?`;
}
export function languageChangedText(language) {
 return {en:'We can speak English now.',ur:'اب ہم اردو میں بات کریں گے۔',roman_ur:'Ab hum Roman Urdu mein baat karein ge.'}[language];
}
export function languageAppliedText(language) {
 return {en:'The app language is now English.',ur:'ایپ کی زبان اب اردو ہے۔',roman_ur:'App ki language ab Roman Urdu hai.'}[language];
}
export function languageProposalText(language) {
 return {en:'Please confirm the app language change.',ur:'ایپ کی زبان بدلنے کی تصدیق کریں۔',roman_ur:'App ki language badalne ki tasdeeq karein.'}[language];
}
export function selectedLanguageOption(message,question,decision) {
 const text=String(message).trim().toLowerCase();
 const code=languages.find(l=>l===text||labels[l].toLowerCase()===text||({en:'انگریزی',ur:'اردو',roman_ur:'رومن اردو'}[l]===text));
 if(code&&question.options.includes(code))return code;
 if(decision==='confirm'&&question.options.length===1)return question.options[0];
 return null;
}
