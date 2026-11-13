// Frame counts for getVideoPlaybackQuality(): the host's counts, plus frames it showed but that
// were never copied into the engine as dropped.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameQuality } from '../dist/services/media-quality.js';

const video = (total, dropped, corrupted = 0) => ({
  getVideoPlaybackQuality: () => ({
    totalVideoFrames: total,
    droppedVideoFrames: dropped,
    corruptedVideoFrames: corrupted,
  }),
});

test('media quality: the counts of the host video', () => {
  assert.deepEqual(new FrameQuality().counts(video(120, 3, 1)), [120, 3, 1]);
});

test('media quality: no counts where the host has none', () => {
  assert.equal(new FrameQuality().counts({}), undefined);
});

test('media quality: every shown frame copied, nothing dropped', () => {
  const quality = new FrameQuality();
  for (let frame = 1; frame <= 60; frame++) {
    quality.presented(frame);
    quality.copied(frame === 1);
  }
  assert.deepEqual(quality.counts(video(60, 0)), [60, 0, 0]);
});

test('media quality: a copy every second shown frame drops the others', () => {
  const quality = new FrameQuality();
  for (let frame = 1; frame <= 60; frame++) {
    quality.presented(frame);
    if (frame % 2) quality.copied(frame === 1);
  }
  // Copies of frames 1, 3, ..., 59: 29 frames in between never reached the page
  assert.deepEqual(quality.counts(video(60, 2)), [60, 31, 0]);
});

test('media quality: the same frame copied twice is no drop', () => {
  const quality = new FrameQuality();
  quality.presented(1);
  quality.copied(true);
  quality.copied(false);
  quality.presented(2);
  quality.copied(false);
  assert.deepEqual(quality.counts(video(2, 0)), [2, 0, 0]);
});

test('media quality: frames shown while copies paused (seek, hidden view) are no drop', () => {
  const quality = new FrameQuality();
  quality.presented(1);
  quality.copied(true);
  quality.presented(40);
  quality.copied(true);
  quality.presented(41);
  quality.copied(false);
  assert.deepEqual(quality.counts(video(41, 0)), [41, 0, 0]);
});

test('media quality: dropped never exceeds the total', () => {
  const quality = new FrameQuality();
  quality.presented(1);
  quality.copied(true);
  quality.presented(10);
  quality.copied(false);
  assert.deepEqual(quality.counts(video(5, 0)), [5, 5, 0]);
});
