/** Preserve the raw override: empty means dynamically follow the narration model. */
export const previewModelDraft = (configured: string | null | undefined) => configured ?? '';

/** Empty string is the backend's explicit remove-override sentinel; null means leave unchanged. */
export const previewModelPatch = (draft: string) => draft.trim();
