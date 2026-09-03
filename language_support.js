export const DEFAULT_PREFERRED_LANGUAGE = 'English';

export const SUPPORTED_PREFERRED_LANGUAGES = Object.freeze([
  'English',
  'Urdu',
  'Roman Urdu',
]);

const languageByNormalizedValue = new Map(
  SUPPORTED_PREFERRED_LANGUAGES.map((language) => [
    language.toLowerCase(),
    language,
  ]),
);

export function normalizePreferredLanguage(value) {
  const cleaned = typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
  return languageByNormalizedValue.get(cleaned.toLowerCase()) ||
    DEFAULT_PREFERRED_LANGUAGE;
}

export function preferredLanguageIdentity(value) {
  return normalizePreferredLanguage(value)
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export async function readPreferredLanguageForUser(db, userId) {
  if (!db || typeof db.execute !== 'function' || !userId) {
    return DEFAULT_PREFERRED_LANGUAGE;
  }

  const [rows] = await db.execute(
    `SELECT preferred_language
     FROM patient_profiles
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );

  return normalizePreferredLanguage(rows?.[0]?.preferred_language);
}

export function aiLanguageInstruction(
  preferredLanguage,
  {
    scope = 'patient-facing generated natural-language text',
  } = {},
) {
  const language = normalizePreferredLanguage(preferredLanguage);
  const languageRule = language === 'Urdu'
    ? 'Use clear Urdu in Urdu script.'
    : language === 'Roman Urdu'
      ? 'Use simple, natural Roman Urdu written only with Latin characters. Do not output Urdu script.'
      : 'Use clear, simple English.';

  return `Server-selected preferred language: ${language}.
Apply this language only to ${scope}.
${languageRule}
Do not translate, normalize, reinterpret, calculate, replace, or modify safety-critical medical source facts.
Preserve exactly any supplied medicine names, product names, numeric doses, strengths, units, route, frequency, treatment duration, dates, appointment dates, verified medical phrases, verified exact clock times, and original extracted instruction text.
Do not transform exact facts such as 2:00 PM, 5 mg, after breakfast, bedtime, once daily, or a medicine/product name into another time, amount, wording, frequency, or language.
Keep JSON property names and canonical machine values unchanged, including status values, category values, reviewStatus, signal, nextAction, intent, period, responseProfile, taskKind, grounding, action/actionType, IDs, keys, and risk points.`;
}

const AI_FALLBACK_TEXT = Object.freeze({
  English: Object.freeze({
    noActiveIngredientReadable:
      'No active ingredient was readable. Try a clear photo of the ingredients panel.',
    confirmLabelAgainstPackage:
      'Confirm the extracted label text against the package.',
    noActiveIngredientPurpose:
      'No active ingredient was readable, so purpose consistency could not be checked.',
    purposeCheckUnavailable:
      'Purpose consistency could not be checked automatically.',
    confirmPackagePrescription:
      'Please confirm that this package belongs to the medicine written in the prescription.',
    ingredientPurposeUnreliable:
      'The ingredient and written purpose could not be compared reliably.',
    confirmIntendedMedicine:
      'Please confirm that this package is the medicine intended for this instruction.',
    slashDoseFrequencyAmbiguity:
      'The slash between the amount and frequency may be interpreted in more than one way.',
    slashDoseFrequencyInterpretation:
      'The written amount may be an amount per dose or a total amount divided across the stated frequency.',
    slashDoseFrequencySafety:
      'Confirm whether the written amount is per dose or the total daily amount before using this instruction.',
    duplicateMedicineAmbiguity:
      'Possible duplicate medicine instruction detected. Compare both source entries before confirming either as a separate medicine instruction.',
    safetyNoTrustedSource:
      'No matching trusted source was found. The written instruction has not been changed.',
    safetyConfirmExactInstruction:
      'Please confirm the exact medicine, amount per dose, frequency, route, and duration written here.',
    scheduleSlotReason: ({ index, expectedCount, frequency, label }) =>
      `Reminder slot ${index} of ${expectedCount} was organized from the verified "${frequency}" frequency. ${label} is a reminder period for confirmation, not a change to the medical instruction.`,
    legacyRealityReason:
      'Legacy compatibility question for practical care-plan fit.',
    legacyMorningRoutineQuestion:
      'Which option best matches your usual morning routine?',
    legacyDaytimeAccessQuestion:
      'Can you access this medicine or task during the daytime?',
    legacyEveningRoutineQuestion:
      'Can you follow the stated evening or bedtime instruction?',
    legacyCaregiverSupportQuestion:
      'Is the required help available for this care task?',
    legacyTravelAccessQuestion:
      'Can you reach the clinic or laboratory at the stated time?',
    legacyMedicineAccessQuestion:
      'Have you obtained the medicines listed in this verified plan?',
    agentUnavailable:
      'I could not complete that request right now. Nothing was changed. Please try again in a little while.',
    agentDisabled:
      'The SehatMate assistant is currently unavailable.',
    agentPermissionDenied:
      'I cannot make changes to your medicines, doses, times, or care plan. Nothing was changed, and your verified plan stays exactly as it is.',
  }),
  Urdu: Object.freeze({
    noActiveIngredientReadable:
      'کوئی فعال جزو پڑھا نہیں جا سکا۔ اجزا کے پینل کی واضح تصویر دوبارہ لیں۔',
    confirmLabelAgainstPackage:
      'نکالا گیا لیبل متن پیکج کے ساتھ ملا کر تصدیق کریں۔',
    noActiveIngredientPurpose:
      'کوئی فعال جزو پڑھا نہیں جا سکا، اس لیے مقصد کی مطابقت چیک نہیں ہو سکی۔',
    purposeCheckUnavailable:
      'مقصد کی مطابقت خودکار طور پر چیک نہیں ہو سکی۔',
    confirmPackagePrescription:
      'براہ کرم تصدیق کریں کہ یہ پیکج نسخے میں لکھی دوا ہی کا ہے۔',
    ingredientPurposeUnreliable:
      'جزو اور لکھے ہوئے مقصد کا قابل اعتماد موازنہ نہیں ہو سکا۔',
    confirmIntendedMedicine:
      'براہ کرم تصدیق کریں کہ یہ پیکج اسی دوا کا ہے جو اس ہدایت کے لیے مطلوب ہے۔',
    slashDoseFrequencyAmbiguity:
      'مقدار اور تعدد کے درمیان / کا نشان ایک سے زیادہ طریقے سے سمجھا جا سکتا ہے۔',
    slashDoseFrequencyInterpretation:
      'لکھی ہوئی مقدار ہر خوراک کی مقدار ہو سکتی ہے یا بیان کردہ تعدد کے لیے کل مقدار ہو سکتی ہے۔',
    slashDoseFrequencySafety:
      'اس ہدایت پر عمل کرنے سے پہلے تصدیق کریں کہ لکھی ہوئی مقدار ہر خوراک کے لیے ہے یا کل روزانہ مقدار ہے۔',
    duplicateMedicineAmbiguity:
      'ممکن ہے دوا کی یہ ہدایت دہرائی ہوئی ہو۔ دونوں اصل اندراجات کا موازنہ کریں، پھر کسی ایک کو الگ دوا کی ہدایت کے طور پر تصدیق کریں۔',
    safetyNoTrustedSource:
      'کوئی ملتا ہوا قابل اعتماد ماخذ نہیں ملا۔ لکھی ہوئی ہدایت تبدیل نہیں کی گئی۔',
    safetyConfirmExactInstruction:
      'براہ کرم یہاں لکھی ہوئی دوا، ہر خوراک کی مقدار، تعدد، طریقہ استعمال، اور مدت کی تصدیق کریں۔',
    scheduleSlotReason: ({ index, expectedCount, frequency, label }) =>
      `یاددہانی کا خانہ ${index} از ${expectedCount} تصدیق شدہ "${frequency}" تعدد سے ترتیب دیا گیا۔ ${label} تصدیق کے لیے یاددہانی کا دورانیہ ہے، طبی ہدایت میں تبدیلی نہیں۔`,
    legacyRealityReason:
      'یہ عملی دیکھ بھال کے منصوبے کی مطابقت جانچنے کے لیے پرانا مطابقتی سوال ہے۔',
    legacyMorningRoutineQuestion:
      'کون سا اختیار آپ کے عام صبح کے معمول سے سب سے بہتر میل کھاتا ہے؟',
    legacyDaytimeAccessQuestion:
      'کیا دن کے وقت یہ دوا یا کام آپ کی پہنچ میں ہوتا ہے؟',
    legacyEveningRoutineQuestion:
      'کیا آپ شام یا سونے کے وقت لکھی ہوئی ہدایت پر عمل کر سکتے ہیں؟',
    legacyCaregiverSupportQuestion:
      'کیا اس دیکھ بھال کے کام کے لیے ضروری مدد دستیاب ہے؟',
    legacyTravelAccessQuestion:
      'کیا آپ مقررہ وقت پر کلینک یا لیبارٹری پہنچ سکتے ہیں؟',
    legacyMedicineAccessQuestion:
      'کیا آپ نے اس تصدیق شدہ منصوبے میں لکھی دوائیں حاصل کر لی ہیں؟',
    agentUnavailable:
      'میں ابھی یہ درخواست مکمل نہیں کر سکا۔ کچھ بھی تبدیل نہیں ہوا۔ براہ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔',
    agentDisabled:
      'SehatMate اسسٹنٹ فی الحال دستیاب نہیں ہے۔',
    agentPermissionDenied:
      'میں آپ کی دواؤں، خوراک، اوقات یا دیکھ بھال کے منصوبے میں تبدیلی نہیں کر سکتا۔ کچھ بھی تبدیل نہیں ہوا، اور آپ کا تصدیق شدہ منصوبہ بالکل ویسا ہی ہے۔',
  }),
  'Roman Urdu': Object.freeze({
    noActiveIngredientReadable:
      'Koi active ingredient readable nahi tha. Ingredients panel ki clear photo dobara lein.',
    confirmLabelAgainstPackage:
      'Extracted label text ko package ke saath confirm karein.',
    noActiveIngredientPurpose:
      'Koi active ingredient readable nahi tha, is liye purpose consistency check nahi ho saki.',
    purposeCheckUnavailable:
      'Purpose consistency automatically check nahi ho saki.',
    confirmPackagePrescription:
      'Please confirm karein ke yeh package prescription mein likhi medicine ka hai.',
    ingredientPurposeUnreliable:
      'Ingredient aur written purpose ka reliable comparison nahi ho saka.',
    confirmIntendedMedicine:
      'Please confirm karein ke yeh package isi instruction ke liye intended medicine ka hai.',
    slashDoseFrequencyAmbiguity:
      'Amount aur frequency ke darmiyan / ka nishan aik se zyada tareeqon se samjha ja sakta hai.',
    slashDoseFrequencyInterpretation:
      'Likhi hui amount per dose ho sakti hai ya stated frequency ke liye total amount ho sakti hai.',
    slashDoseFrequencySafety:
      'Is instruction ko use karne se pehle confirm karein ke likhi hui amount per dose hai ya total daily amount.',
    duplicateMedicineAmbiguity:
      'Possible duplicate medicine instruction detect hui hai. Dono source entries compare karein, phir kisi ek ko separate medicine instruction ke taur par confirm karein.',
    safetyNoTrustedSource:
      'Koi matching trusted source nahi mila. Written instruction change nahi ki gayi.',
    safetyConfirmExactInstruction:
      'Please yahan likhi exact medicine, amount per dose, frequency, route, aur duration confirm karein.',
    scheduleSlotReason: ({ index, expectedCount, frequency, label }) =>
      `Reminder slot ${index} of ${expectedCount} verified "${frequency}" frequency se organize hua. ${label} confirmation ke liye reminder period hai, medical instruction mein change nahi.`,
    legacyRealityReason:
      'Legacy compatibility question practical care-plan fit ke liye hai.',
    legacyMorningRoutineQuestion:
      'Kaunsa option aap ke usual morning routine se sab se behtar match karta hai?',
    legacyDaytimeAccessQuestion:
      'Kya aap daytime mein is medicine ya task tak access kar sakte hain?',
    legacyEveningRoutineQuestion:
      'Kya aap stated evening ya bedtime instruction follow kar sakte hain?',
    legacyCaregiverSupportQuestion:
      'Kya is care task ke liye required help available hai?',
    legacyTravelAccessQuestion:
      'Kya aap stated time par clinic ya laboratory pohanch sakte hain?',
    legacyMedicineAccessQuestion:
      'Kya aap ne is verified plan mein listed medicines hasil kar li hain?',
    agentUnavailable:
      'Main abhi yeh request complete nahi kar saka. Kuch bhi change nahi hua. Please thori der baad dobara try karein.',
    agentDisabled:
      'SehatMate assistant filhal available nahi hai.',
    agentPermissionDenied:
      'Main aap ki medicines, dose, timings ya care plan mein change nahi kar sakta. Kuch bhi change nahi hua, aur aap ka verified plan bilkul waisa hi hai.',
  }),
});

export function localizedAiFallbackText(key, preferredLanguage, values = {}) {
  const language = normalizePreferredLanguage(preferredLanguage);
  const template = AI_FALLBACK_TEXT[language]?.[key] ||
    AI_FALLBACK_TEXT.English[key] ||
    '';
  return typeof template === 'function' ? template(values) : template;
}
