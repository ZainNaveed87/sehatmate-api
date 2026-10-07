import {canonicalAgentLanguage} from './agent_session_store.js';

// Existing authenticated profile preference, shared by Agent output and voice startup.
export async function readProfileLanguage(pool,userId) {
  const [rows]=await pool.execute(
    'SELECT preferred_language FROM patient_profiles WHERE user_id = ? LIMIT 1',[userId]);
  return canonicalAgentLanguage(rows[0]?.preferred_language);
}

export function voiceLanguageProfile(value) {
  const language=canonicalAgentLanguage(value);
  return {language,sttLanguage:language==='en'?'en':'ur'};
}
