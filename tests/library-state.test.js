import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearItemState,
  normalizeLibraryState,
  progressRatio,
  recordProgress,
  resumeTime,
  toggleFavorite
} from '../src/library-state.js';

function frozenState() {
  return Object.freeze({
    favorites: Object.freeze(['alpha']),
    progress: Object.freeze({
      alpha: Object.freeze({ currentTime: 20, duration: 100, updatedAt: 10 })
    })
  });
}

test('normalization supplies an empty canonical state for malformed roots', () => {
  for (const value of [undefined, null, false, 3, 'state', []]) {
    assert.deepEqual(normalizeLibraryState(value), { favorites: [], progress: {} });
  }
});

test('normalization trims and deduplicates favorite ids', () => {
  const state = normalizeLibraryState({
    favorites: [' alpha ', 'alpha', '', '  ', 7, null, 'beta']
  });

  assert.deepEqual(state.favorites, ['alpha', 'beta']);
});

test('normalization keeps only finite, nonnegative progress records', () => {
  const state = normalizeLibraryState({
    progress: {
      good: { currentTime: 8.5, duration: 90, updatedAt: 123 },
      negative: { currentTime: -1, duration: 90, updatedAt: 123 },
      infinite: { currentTime: 5, duration: Infinity, updatedAt: 123 },
      missing: { currentTime: 5, duration: 90 },
      array: [5, 90, 123],
      zeroes: { currentTime: 0, duration: 0, updatedAt: 0 }
    }
  });

  assert.deepEqual(state.progress, {
    good: { currentTime: 8.5, duration: 90, updatedAt: 123 },
    zeroes: { currentTime: 0, duration: 0, updatedAt: 0 }
  });
});

test('normalization returns detached arrays, maps, and records', () => {
  const input = {
    favorites: ['alpha'],
    progress: { alpha: { currentTime: 20, duration: 100, updatedAt: 10 } }
  };
  const output = normalizeLibraryState(input);

  assert.notEqual(output.favorites, input.favorites);
  assert.notEqual(output.progress, input.progress);
  assert.notEqual(output.progress.alpha, input.progress.alpha);
  output.progress.alpha.currentTime = 30;
  assert.equal(input.progress.alpha.currentTime, 20);
});

test('normalization treats __proto__ as data without prototype pollution', () => {
  const input = JSON.parse('{"progress":{"__proto__":{"currentTime":10,"duration":100,"updatedAt":1}}}');
  const output = normalizeLibraryState(input);

  assert.equal(Object.getPrototypeOf(output.progress), Object.prototype);
  assert.equal(Object.hasOwn(output.progress, '__proto__'), true);
  assert.deepEqual(output.progress.__proto__, { currentTime: 10, duration: 100, updatedAt: 1 });
});

test('toggleFavorite adds and removes ids while leaving the input untouched', () => {
  const original = frozenState();
  const added = toggleFavorite(original, ' beta ');
  const removed = toggleFavorite(added, 'alpha');

  assert.deepEqual(added.favorites, ['alpha', 'beta']);
  assert.deepEqual(removed.favorites, ['beta']);
  assert.deepEqual(original.favorites, ['alpha']);
  assert.notEqual(added, original);
});

test('recordProgress stores an exact resumable record immutably', () => {
  const original = frozenState();
  const result = recordProgress(original, 'beta', 12.25, 60, 500);

  assert.deepEqual(result.progress.beta, { currentTime: 12.25, duration: 60, updatedAt: 500 });
  assert.deepEqual(original.progress, {
    alpha: { currentTime: 20, duration: 100, updatedAt: 10 }
  });
  assert.notEqual(result.progress, original.progress);
});

test('recordProgress clears early and completed playback records', () => {
  const initial = {
    progress: { item: { currentTime: 50, duration: 100, updatedAt: 1 } }
  };

  assert.equal('item' in recordProgress(initial, 'item', 4.999, 100, 2).progress, false);
  assert.equal('item' in recordProgress(initial, 'item', 95, 100, 2).progress, false);
  assert.equal('item' in recordProgress(initial, 'item', 120, 100, 2).progress, false);
  assert.deepEqual(recordProgress(initial, 'item', 94.999, 100, 2).progress.item, {
    currentTime: 94.999,
    duration: 100,
    updatedAt: 2
  });
});

test('recordProgress clears a prior record when new numeric input is invalid', () => {
  const initial = {
    progress: { item: { currentTime: 50, duration: 100, updatedAt: 1 } }
  };

  assert.equal('item' in recordProgress(initial, 'item', Number.NaN, 100, 2).progress, false);
  assert.equal('item' in recordProgress(initial, 'item', 10, 0, 2).progress, false);
  assert.equal('item' in recordProgress(initial, 'item', 10, 100, -1).progress, false);
});

test('clearItemState removes favorite and progress data without mutation', () => {
  const original = frozenState();
  const result = clearItemState(original, 'alpha');

  assert.deepEqual(result, { favorites: [], progress: {} });
  assert.deepEqual(original.favorites, ['alpha']);
  assert.equal(original.progress.alpha.currentTime, 20);
});

test('resumeTime rejects absent, early, and effectively completed records', () => {
  assert.equal(resumeTime({}, 'item', 100), 0);
  assert.equal(resumeTime({ progress: { item: { currentTime: 4, duration: 100, updatedAt: 1 } } }, 'item', 100), 0);
  assert.equal(resumeTime({ progress: { item: { currentTime: 95, duration: 100, updatedAt: 1 } } }, 'item', 100), 0);
  assert.equal(resumeTime({ progress: { item: { currentTime: 10, duration: 100, updatedAt: 1 } } }, 'item', Infinity), 0);
});

test('resumeTime returns the saved time and clamps it strictly below a changed end', () => {
  const state = {
    progress: { item: { currentTime: 80, duration: 200, updatedAt: 1 } }
  };

  assert.equal(resumeTime(state, 'item', 100), 80);
  const clamped = resumeTime(state, 'item', 50);
  assert.ok(clamped < 50);
  assert.ok(clamped >= 0);
});

test('progressRatio returns a bounded display fraction', () => {
  assert.equal(progressRatio({ progress: { item: { currentTime: 25, duration: 100, updatedAt: 1 } } }, 'item'), 0.25);
  assert.equal(progressRatio({ progress: { item: { currentTime: 120, duration: 100, updatedAt: 1 } } }, 'item'), 1);
  assert.equal(progressRatio({ progress: { item: { currentTime: 0, duration: 0, updatedAt: 1 } } }, 'item'), 0);
  assert.equal(progressRatio({}, 'item'), 0);
  assert.equal(progressRatio({}, 'toString'), 0);
});
