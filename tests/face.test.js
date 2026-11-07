import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { LM, coverTransform, headFromLandmarks, mapPoint } from '../src/face.js';

test('cover transform on a portrait phone crops the sides of a 4:3 frame', () => {
  const t = coverTransform(640, 480, 390, 844);
  assert.ok(Math.abs(t.s - 844 / 480) < 1e-9);
  assert.ok(t.ox < -300, `ox ${t.ox}`); // most of the width is off-screen
  const p = mapPoint(t, 0.5, 0.5, true, {});
  assert.ok(Math.abs(p.x - 195) < 1e-6 && Math.abs(p.y - 422) < 1e-6);
});

test('naive mapping (x*W, y*H) shrinks the head ~3x on a portrait phone', () => {
  const t = coverTransform(640, 480, 390, 844);
  const a = mapPoint(t, 0.4, 0.5, false, {});
  const b = mapPoint(t, 0.6, 0.5, false, {});
  const trueWidth = b.x - a.x; // a face 20% of the frame wide
  const naiveWidth = 0.2 * 390;
  assert.ok(trueWidth / naiveWidth > 2.8, `ratio ${trueWidth / naiveWidth}`);
  assert.ok(Math.abs(a.x - 0.4 * 390) > 70, 'and its edge lands ~70 px away');
});

test('mirroring flips x around the centre', () => {
  const t = coverTransform(640, 480, 640, 480);
  assert.equal(mapPoint(t, 0.2, 0.3, true, {}).x, 640 * 0.8);
  assert.equal(mapPoint(t, 0.2, 0.3, false, {}).x, 640 * 0.2);
});

function syntheticFace({ cx = 0.5, cy = 0.5, w = 0.2, h = 0.28, roll = 0, noseShift = 0 } = {}) {
  const lms = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  const rot = (dx, dy) => ({ x: cx + dx * Math.cos(roll) - dy * Math.sin(roll), y: cy + dx * Math.sin(roll) + dy * Math.cos(roll), z: 0 });
  lms[LM.FOREHEAD] = rot(0, -h / 2);
  lms[LM.CHIN] = rot(0, h / 2);
  lms[LM.CHEEK_A] = rot(-w / 2, 0);
  lms[LM.CHEEK_B] = rot(w / 2, 0);
  lms[LM.NOSE_TIP] = rot(noseShift, 0.02);
  return lms;
}

test('upright face: ellipse sits on the chin and extends above the forehead', () => {
  const t = coverTransform(640, 480, 640, 480);
  const out = headFromLandmarks(syntheticFace(), t, true, CONFIG.head, {});
  assert.ok(Math.abs(out.theta) < 1e-9);
  const chinY = 0.64 * 480;
  const foreheadY = 0.36 * 480;
  assert.ok(Math.abs(out.cy + out.b - chinY) < 1e-6, 'bottom of ellipse = chin');
  assert.ok(out.cy - out.b < foreheadY - 30, 'top of ellipse above the forehead landmark');
  assert.ok(Math.abs(out.a - 0.2 * 640 * 0.5 * CONFIG.head.widthScale) < 1e-6);
  assert.ok(Math.abs(out.yaw) < 1e-9);
});

test('rolled face: theta follows the roll (mirrored view flips its sign)', () => {
  // Square frame so a rotation in normalised coordinates is a rotation in pixels.
  const t = coverTransform(480, 480, 480, 480);
  const roll = 0.3;
  const plain = headFromLandmarks(syntheticFace({ roll }), t, false, CONFIG.head, {});
  const mirrored = headFromLandmarks(syntheticFace({ roll }), t, true, CONFIG.head, {});
  assert.ok(Math.abs(plain.theta - roll) < 0.02, `theta ${plain.theta}`);
  assert.ok(Math.abs(mirrored.theta + roll) < 0.02, `theta ${mirrored.theta}`);
});

test('yaw sign follows the nose', () => {
  const t = coverTransform(640, 480, 640, 480);
  const right = headFromLandmarks(syntheticFace({ noseShift: 0.05 }), t, true, CONFIG.head, {});
  const left = headFromLandmarks(syntheticFace({ noseShift: -0.05 }), t, true, CONFIG.head, {});
  assert.ok(right.yaw > 0.3 && left.yaw < -0.3);
});
