import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streetFlow, streetReplayRate } from '../src/layers/streetWater';

test('street flow stays finite and normalized on flat ground and degenerate road data', () => {
  const flow = streetFlow(() => 0, [{ pts: [{x:0,z:0},{x:0,z:0}] }]);
  for (const [x,z] of [[0,0],[450,-450],[-450,450]]) {
    const [dx,dz] = flow(x,z);
    assert.ok(Number.isFinite(dx) && Number.isFinite(dz));
    assert.ok(Math.abs(Math.hypot(dx,dz)-1) < 1e-6);
  }
});

test('advection follows a nearby road and returns to downhill flow away from it', () => {
  const flow = streetFlow(() => 0, [{ pts: [{x:-100,z:0},{x:100,z:0}] }]);
  assert.ok(Math.abs(flow(0,0)[0]) > .95, 'nearby water texture follows the street');
  assert.ok(flow(0,60)[1] < -.9, 'road does not steer distant water');
});

test('local slope can reverse the illustrative current without changing depth', () => {
  const downhill = streetFlow((x,z) => z*.8, []);
  const reversed = streetFlow((x,z) => -z*.8, []);
  assert.ok(downhill(0,0)[1] < 0);
  assert.ok(reversed(0,0)[1] > 0);
});

test('first-inundation playback limits visible rise without changing model depths', () => {
  const before=.5, after=1.0;
  const hoursPerSecond=streetReplayRate(before,after);
  assert.ok(hoursPerSecond>0 && hoursPerSecond<=6);
  assert.ok((after-before)/.25*hoursPerSecond <= .140001);
  assert.equal(streetReplayRate(-2,-1),6, 'skip quickly through dry time');
  assert.equal(streetReplayRate(5,6),6, 'normal replay once the contact phase has passed');
  assert.equal(streetReplayRate(1,1),6, 'no unnecessary delay at a steady level');
});
