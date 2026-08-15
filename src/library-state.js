const MIN_RESUME_SECONDS = 5;
const COMPLETE_RATIO = 0.95;

function normalizedId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizedProgressRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const { currentTime, duration, updatedAt } = value;
  if (![currentTime, duration, updatedAt].every(isFiniteNonNegative)) return null;

  return { currentTime, duration, updatedAt };
}

function setProgressRecord(progress, id, record) {
  // Define the key rather than assigning it so even an id such as "__proto__"
  // remains an ordinary own property and cannot alter the result's prototype.
  Object.defineProperty(progress, id, {
    value: record,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function isMeaningful(record) {
  return Boolean(
    record
    && record.currentTime >= MIN_RESUME_SECONDS
    && record.duration > 0
    && record.currentTime / record.duration < COMPLETE_RATIO
  );
}

/**
 * Return a safe, detached representation of persisted library state.
 * Unknown properties and malformed entries are intentionally discarded.
 */
export function normalizeLibraryState(value) {
  const favorites = [];
  const seenFavorites = new Set();
  const progress = {};

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { favorites, progress };
  }

  if (Array.isArray(value.favorites)) {
    for (const candidate of value.favorites) {
      const id = normalizedId(candidate);
      if (!id || seenFavorites.has(id)) continue;
      seenFavorites.add(id);
      favorites.push(id);
    }
  }

  if (value.progress && typeof value.progress === 'object' && !Array.isArray(value.progress)) {
    for (const [candidateId, candidateRecord] of Object.entries(value.progress)) {
      const id = normalizedId(candidateId);
      const record = normalizedProgressRecord(candidateRecord);
      if (!id || !record) continue;
      setProgressRecord(progress, id, record);
    }
  }

  return { favorites, progress };
}

/** Add or remove an item from favorites without mutating the supplied state. */
export function toggleFavorite(state, id) {
  const next = normalizeLibraryState(state);
  const normalized = normalizedId(id);
  if (!normalized) return next;

  const index = next.favorites.indexOf(normalized);
  if (index === -1) next.favorites.push(normalized);
  else next.favorites.splice(index, 1);
  return next;
}

/**
 * Store resumable playback progress. Very early playback and completed items
 * deliberately have no progress record so they do not produce stale resumes.
 */
export function recordProgress(state, id, currentTime, duration, updatedAt = Date.now()) {
  const next = normalizeLibraryState(state);
  const normalized = normalizedId(id);
  if (!normalized) return next;

  delete next.progress[normalized];

  if (
    !isFiniteNonNegative(currentTime)
    || !isFiniteNonNegative(duration)
    || !isFiniteNonNegative(updatedAt)
    || duration === 0
    || currentTime < MIN_RESUME_SECONDS
    || currentTime / duration >= COMPLETE_RATIO
  ) {
    return next;
  }

  setProgressRecord(next.progress, normalized, { currentTime, duration, updatedAt });
  return next;
}

/** Remove both favorite and playback state for an item. */
export function clearItemState(state, id) {
  const next = normalizeLibraryState(state);
  const normalized = normalizedId(id);
  if (!normalized) return next;

  next.favorites = next.favorites.filter((favoriteId) => favoriteId !== normalized);
  delete next.progress[normalized];
  return next;
}

/** Return a safe seek target for a saved, meaningful progress record. */
export function resumeTime(state, id, duration) {
  const normalized = normalizeLibraryState(state);
  const normalizedItemId = normalizedId(id);
  if (!normalizedItemId || !isFiniteNonNegative(duration) || duration === 0) return 0;

  const record = Object.hasOwn(normalized.progress, normalizedItemId)
    ? normalized.progress[normalizedItemId]
    : null;
  if (!isMeaningful(record)) return 0;

  // Keep the seek target strictly below duration without imposing an arbitrary
  // multi-second rewind when a media source reports a shorter duration.
  const endExclusive = Math.max(0, duration - Math.max(Number.EPSILON, duration * Number.EPSILON));
  return Math.min(record.currentTime, endExclusive);
}

/** Return a display-friendly progress fraction in the inclusive range 0..1. */
export function progressRatio(state, id) {
  const normalized = normalizeLibraryState(state);
  const normalizedItemId = normalizedId(id);
  if (!normalizedItemId) return 0;

  const record = Object.hasOwn(normalized.progress, normalizedItemId)
    ? normalized.progress[normalizedItemId]
    : null;
  if (!record || record.duration === 0) return 0;
  return Math.min(1, record.currentTime / record.duration);
}
