/** Normalize an optional user-authored mistake note without inventing a cause. */
export function normalizeMistakeNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined || note === null) return note;
  const normalized = note.trim();
  return normalized.length === 0 ? null : normalized;
}
