export function voiceError(code, status = 409) {
  return Object.assign(new Error(code), {code, status});
}
export function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw voiceError('VOICE_INVALID_REQUEST',422);
}
export const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const ownedId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
export const millis = value => new Date(value).getTime();
