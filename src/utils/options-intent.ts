export const OPTIONS_INTENT_STORAGE_KEY = 'gsm_options_intent_v1';

export type OptionsIntentSection = 'github' | 'watch';

export type OptionsIntent = {
  section: OptionsIntentSection;
  requestedAt: number;
};

export function parseOptionsIntent(value: unknown): OptionsIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  if (
    (candidate.section !== 'github' && candidate.section !== 'watch')
    || typeof candidate.requestedAt !== 'number'
    || !Number.isFinite(candidate.requestedAt)
  ) return null;

  return {
    section: candidate.section,
    requestedAt: candidate.requestedAt,
  };
}

export async function writeOptionsIntent(section: OptionsIntentSection): Promise<void> {
  if (section !== 'github' && section !== 'watch') {
    throw new TypeError('Invalid Options intent section.');
  }

  const intent: OptionsIntent = {
    section,
    requestedAt: Date.now(),
  };
  await chrome.storage.session.set({ [OPTIONS_INTENT_STORAGE_KEY]: intent });
}

export async function consumeOptionsIntent(): Promise<OptionsIntent | null> {
  const values = await chrome.storage.session.get(OPTIONS_INTENT_STORAGE_KEY);
  const intent = parseOptionsIntent(values[OPTIONS_INTENT_STORAGE_KEY]);
  await chrome.storage.session.remove(OPTIONS_INTENT_STORAGE_KEY);
  return intent;
}
