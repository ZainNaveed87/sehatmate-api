// Internal voice policy. No room/client language or medical facts enter this path.
const PHRASES = Object.freeze({
  greeting: {
    en: 'Hello! How can I help you?',
    ur: 'السلام علیکم! میں آپ کی کیا مدد کر سکتا ہوں؟',
    roman_ur: 'Assalam o alaikum! Main aap ki kya madad kar sakta hoon?',
  },
  acknowledgement: {
    en: "You're welcome. Let me know if you need anything else.",
    ur: 'خوش رہیں۔ مزید مدد چاہیے تو بتائیں۔',
    roman_ur: 'Khush rahein. Mazeed madad chahiye to batayein.',
  },
  audio_check: {
    en: 'Your message came through. How can I help?',
    ur: 'آپ کا پیغام مل گیا ہے۔ میں کیا مدد کر سکتا ہوں؟',
    roman_ur: 'Aap ka paigham mil gaya hai. Main kya madad kar sakta hoon?',
  },
});

const EXACT = new Map([
  ['hello','greeting'], ['hi','greeting'], ['سلام','greeting'], ['السلام علیکم','greeting'],
  ['assalam o alaikum','greeting'], ['thank you','acknowledgement'], ['thanks','acknowledgement'],
  ['شکریہ','acknowledgement'], ['shukriya','acknowledgement'], ['can you hear me','audio_check'],
]);

export function voiceConversationReply({message,language,state,clientContext}) {
  if (typeof message!=='string' || message.length>80) return null;
  if (clientContext || state?.pendingConfirmation || state?.pendingDraft || state?.pendingClarification) return null;
  // Whole-message matching only. No substring/intent model can expand this allowlist.
  const normalized=String(message).trim().toLowerCase().replace(/[.!?؟]+$/u,'').trim();
  const kind=EXACT.get(normalized);
  const reply=PHRASES[kind]?.[language];
  return reply ? {reply,kind} : null;
}

export function recordVoiceLatency(stage,started) {
  if (!['PLANNER','GROUNDED_REPLY','TOTAL'].includes(stage)) return;
  const ms=Math.max(0,performance.now()-started);
  const bucket=ms<100?'LT_100MS':ms<500?'100_499MS':ms<1000?'500_999MS':
    ms<2000?'1_2S':ms<5000?'2_5S':ms<10000?'5_10S':ms<20000?'10_20S':'GE_20S';
  console.info(`VOICE_AGENT_LATENCY:${stage}:${bucket}`);
}
