// Notes tab — the project-level Project Notes (cross-paper synthesis). Reuses the notes
// screen, which falls back to target 'working' when no route param is present; per-paper
// notes are still pushed as stack routes at /notes/<slug>.

export { default } from '../notes/[target]';
