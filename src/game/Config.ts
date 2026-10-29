// Shared tuning constants. Distances are in world units.
// World scale: 1 unit = 51.2 Rocket League "uu", so the 200-unit field matches RL's 10240 uu length
// and every speed, acceleration and size below converts from RL values with the same factor.
export const UU = 1 / 51.2;

export const PHYSICS_HZ = 120;
export const DT = 1 / PHYSICS_HZ;

// Arena
export const ARENA = {
  halfLength: 100, // x extent (goals at +/-x)        5120 uu
  halfWidth: 80, // z extent                           4096 uu
  height: 40, // ceiling height                        2044 uu
  cornerRadius: 24, // vertical corner rounding (seen from above)
  rampRadius: 7, // wall-to-floor / wall-to-ceiling curve radius
  goalWidth: 35, //                                    1786 uu
  goalHeight: 12.5, //                                  642 uu
  goalDepth: 16, //                                     880 uu
};

/** Size multiplier relative to the original 100 x 70 field (used for layout-only numbers). */
export const WORLD_SCALE = ARENA.halfLength / 50;

// Car
export const CAR = {
  // Hitbox: between RL's Octane and Dominus (128 x 84 x 36 uu). x = forward, y = up, z = right.
  halfExtents: { x: 1.25, y: 0.35, z: 0.8 },
  wheelRadius: 0.36,
  suspensionRest: 0.42,
  wheelOffsets: [
    [0.86, -0.16, -0.72],
    [0.86, -0.16, 0.72],
    [-0.86, -0.16, -0.72],
    [-0.86, -0.16, 0.72],
  ] as [number, number, number][],
  springK: 62,
  springC: 6.2,
  gravity: 650 * UU,
  maxDriveSpeed: 1410 * UU,
  maxSpeed: 2300 * UU,
  supersonic: 2200 * UU,
  supersonicExit: 2100 * UU,
  brakeAccel: 3500 * UU,
  coastDecel: 525 * UU,
  boostAccel: 991.67 * UU * 1.06,
  boostDrain: 33.3,
  jumpImpulse: 292 * UU,
  jumpHoldAccel: 1458 * UU,
  jumpHoldTime: 0.2,
  dodgeWindow: 1.5,
  dodgeImpulse: 500 * UU,
  dodgeDuration: 0.65,
  dodgeSpin: (Math.PI * 2) / 0.65,
  stickyAccel: 325 * UU * 1.6,
  // Wall/ceiling grip ramps with speed. Below wallGripMinSpeed there is none and the car falls.
  wallGripMinSpeed: 700 * UU, // ~13.7
  wallGripFullSpeed: 2000 * UU, // ~39
  wallGripMax: 0.85 * 650 * UU, // always weaker than gravity: nothing can hang on the ceiling
  wallPeel: 3,
  maxAngVel: 5.5,
  airTorque: { roll: 36.08, pitch: 12.15, yaw: 8.92 },
  airDamp: { roll: 4.75, pitch: 2.85, yaw: 1.89 },
  lateralGrip: 22,
  slideGrip: 2.4,
  startBoost: 33,
};

// Ball
export const BALL = {
  radius: 92.75 * UU, // 1.81
  gravity: 520 * UU,
  restitution: 0.68,
  maxSpeed: 6000 * UU,
  drag: 0.03,
  mass: 0.18, // relative to car mass of 1
  /** Relative car-ball speed below which touches count as dribble touches (~600 uu/s). */
  dribbleSpeed: 450 * UU,
};

export const MATCH_LENGTH = 300; // seconds

export type Team = 0 | 1; // 0 = blue (defends -x), 1 = orange (defends +x)
export const TEAM_COLORS = [0x2f8cff, 0xff8a1e];
export const TEAM_NAMES = ['BLUE', 'ORANGE'];

export function curveLerp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return table[table.length - 1][1];
}

// Rocket League throttle acceleration curve (speed uu/s -> accel uu/s^2)
export const THROTTLE_CURVE: [number, number][] = [
  [0, 1600],
  [1400, 160],
  [1410, 0],
];

// Rocket League steering curvature (speed uu/s -> curvature 1/uu)
export const STEER_CURVE: [number, number][] = [
  [0, 0.0069],
  [500, 0.00398],
  [1000, 0.00235],
  [1500, 0.001375],
  [1750, 0.0011],
  [2500, 0.00088],
];

// Rocket League ball hit extra-impulse scale (relative speed uu/s -> factor)
export const HIT_SCALE_CURVE: [number, number][] = [
  [0, 0.65],
  [500, 0.65],
  [2300, 0.55],
  [4600, 0.3],
];

/** Converts Rocket League map coords (x across, y along) to ours. */
export function rlToWorld(x: number, y: number): [number, number] {
  return [y * (ARENA.halfLength / 5120), x * ((ARENA.halfWidth * 0.97) / 4096)];
}

/** Resting height of the car's origin above flat ground (spring equilibrium incl. sticky force). */
export function carRideHeight(): number {
  const x = (CAR.gravity + CAR.stickyAccel) / (4 * CAR.springK);
  return CAR.suspensionRest + CAR.wheelRadius - x - CAR.wheelOffsets[0][1];
}
