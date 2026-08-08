import { clamp, resolveAct, smoothstep } from './math.mjs';

export function createSpringState(initial = 0) {
  return {
    value: clamp(Number.isFinite(initial) ? initial : 0, 0, 1),
    velocity: 0,
  };
}

export function stepSpring(
  state,
  target,
  deltaSeconds,
  { stiffness = 115, damping = 22 } = {},
) {
  const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 1 / 20);
  const boundedTarget = clamp(Number.isFinite(target) ? target : 0, 0, 1);
  const acceleration = (boundedTarget - state.value) * stiffness;
  const velocity = (state.velocity + acceleration * dt) * Math.exp(-damping * dt);
  const rawValue = state.value + velocity * dt;
  const value = clamp(rawValue, 0, 1);

  return {
    value,
    velocity: value !== rawValue ? 0 : velocity,
  };
}

export function computeTimelineFrame(progress, world) {
  const bounded = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const act = resolveAct(bounded, world.acts.length);

  return {
    progress: bounded,
    actIndex: act.index,
    local: act.local,
    plateA: act.index,
    plateB: Math.min(act.index + 1, world.acts.length - 1),
    blend: smoothstep(0.62, 0.94, act.local),
  };
}
