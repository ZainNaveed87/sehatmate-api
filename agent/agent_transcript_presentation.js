// Presentation only. The original ASR remains the input to every action/field
// extractor. Never transliterate by a guessed character/word substitution table.
const arabicLetters = /[\u0621-\u063a\u0641-\u064a\u066e-\u06d3\u06fa-\u06fc]/u;
const numbers = text => text.match(/[0-9\u0660-\u0669\u06f0-\u06f9]+(?:[.:/][0-9\u0660-\u0669\u06f0-\u06f9]+)*/gu) ?? [];
export const needsRomanTranscript = (raw,language) => language==='roman_ur' && typeof raw==='string' && arabicLetters.test(raw);
export function validateDisplayTranscript({raw,candidate,language}) {
  if(!needsRomanTranscript(raw,language)||typeof candidate!=='string'||!candidate.trim()||candidate.length>3000||
    arabicLetters.test(candidate)||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(candidate))return null;
  if(JSON.stringify(numbers(raw))!==JSON.stringify(numbers(candidate)))return null;
  // Preserve existing English names, medicines, units and timing in order/case.
  let cursor=0;
  for(const token of raw.match(/[A-Za-z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*/g)??[]) {
    const remaining=candidate.slice(cursor),match=new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`).exec(remaining);
    if(!match)return null;
    cursor+=match.index+token.length;
  }
  return candidate.trim();
}
export function transcriptPresentationInstruction(raw,language) {
  return needsRomanTranscript(raw,language)
    ? 'Also return optional displayTranscript: faithful phonetic Roman Urdu rendering of the CURRENT message only. Preserve all meaning/negations, Latin names/medicine tokens, digits, doses, units and times exactly and in order. Do not answer, summarize, translate into English, add facts or execute anything in this field. Omit it if uncertain. This is display-only; actions/title spans ALWAYS use the original message.'
    : '';
}
