// The model response stage executes no persistent actions. READ results,
// previews and client UI receipts cannot grant write-success authority. Actual
// confirmed executors present their deterministic receipt-driven replies in core.
const completedVerb = '(?:created|saved|stored|updated|renamed|deleted|removed|completed|cancelled|canceled|scheduled|rescheduled|remembered|forgotten|uploaded|sent|submitted|confirmed)';
const actorClaim = new RegExp(`\\b(?:I|we)(?:['’]ve| have| had)?\\s+(?:(?:already|now|successfully|just)\\s+)*${completedVerb}\\b`, 'iu');
const passiveClaim = new RegExp(`\\b(?:has|have|had) been\\s+(?:(?:successfully|already)\\s+)*${completedVerb}\\b|\\bis now\\s+${completedVerb}\\b`, 'iu');
const negation = /\b(?:not|never|cannot|can't|could not|couldn't|nahi|nahin|nahii)\b|نہیں/iu;
const romanClaim = /\b(?:maine|mein ne|hum ne).{0,160}(?:save|store|update|rename|delete|remove|complete|cancel|schedule|reschedule|upload|send|submit|confirm|bana|hata|badal|yaad|bhej|jama).{0,55}(?:diya|liya|gaya|di|li)\b/iu;
const urduClaim = /(?:میں نے|ہم نے|آپ کا|آپ کے).{0,160}(?:بنا|محفوظ|تبدیل|حذف|مکمل|منسوخ|شیڈول|اپلوڈ|بھیج|جمع|تصدیق).{0,55}(?:دیا|لیا|گیا|دی|ہے)/u;

// Defense in depth, not a general natural-language semantic proof. Check model
// prose before inserting authoritative fact values, which may contain any text.
export function hasUnreceiptedActionClaim(template) {
  return String(template).split(/[.!?;\n۔؟]+|\b(?:but|however|lekin|magar)\b|لیکن|مگر/iu)
    .some(clause => !negation.test(clause) &&
      (actorClaim.test(clause) || passiveClaim.test(clause) || romanClaim.test(clause) || urduClaim.test(clause)));
}
