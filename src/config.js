// All tunables live here so thresholds can be tuned without touching logic.
// Units: ms for time, CSS px for distance, px/s for speed.

export const CONFIG = {
  camera: {
    idealWidth: 640, // the landmark model works on a 256px crop; more pixels only cost upload time
    idealHeight: 480,
    maxFrameRate: 30,
  },

  detect: {
    maxHz: 30, // never infer more often than the camera delivers frames
    minHz: 8, // floor while a face is tracked, however slow the device
    idleHz: 5, // no face for a while: poll slowly to save battery
    idleAfterMs: 1500,
    mainThreadShare: 0.4, // inference may use at most 40% of main-thread wall time
  },

  expr: {
    // Scores are blendshape values after per-user baseline removal, 0..1.
    smileOn: 0.42,
    smileOff: 0.28,
    smileHoldMs: 120,
    smileReleaseMs: 220,

    laughSmileMin: 0.35, // a laugh must also be a smile: rules out yawns and surprise
    laughSmileKeep: 0.22,
    laughJawOn: 0.3,
    laughJawOff: 0.16,
    laughAccumMs: 150, // leaky evidence, so "ha-ha-ha" pulses still count
    laughDecay: 0.6, // evidence drains at 60% of the rate it fills
    laughReleaseMs: 380,
    laughRefractoryMs: 300,

    vetoFunnel: 0.35, // "O" mouth (surprise, singing) is not a laugh
    vetoPucker: 0.45,

    yawMax: 0.45, // beyond ~40 degrees the blendshapes get unreliable
    unreliableTimeoutMs: 1200,
    lostResetMs: 400,

    baselineCap: 0.3, // a resting face can never absorb a real smile
    baselineRiseTauMs: 20000,
    baselineFallTauMs: 300,
    smoothTauMs: 50,
  },

  head: {
    widthScale: 1.12, // cheekbone width -> head width incl. ears and hair
    heightScale: 1.3, // chin-to-forehead -> chin-to-crown incl. hair
    maxSpeed: 2500,
    extrapolateMs: 50,
    resetAfterLostMs: 250,
  },

  physics: {
    gravity: 520,
    sparkDrag: 1.1, // 1/s
    restitution: 0.55,
    friction: 0.12, // share of sliding speed lost per contact
    ember: { gravity: 260, drag: 2.6, restitution: 0.12, friction: 0.06 }, // willow: floats, lands, slides off
    bead: { gravity: 420, friction: 0.3 }, // water on the head: clings, crawls down, drips off the sides
    rainSpeed: [950, 1350],
    splashGravity: 1300,
    trailGravity: 60,
    glintMinSpeed: 160, // impacts faster than this flash a small star at the contact point
    glintsPerStep: 4,
    crackleShare: 0.35, // glitter that pops when it burns out
    beadChance: 0.12, // share of raindrops landing on the crown that stay as a bead
    maxBeads: 16,
    contactAge: 0.12, // s of life a spark or ember loses per contact with the head: they burn out there
  },

  rain: {
    cloudWidth: [1.3, 1.7], // x head width: just past the threshold -> biggest smile
    cloudGap: 0.4, // x head half-height, between the crown and the cloud's base
    minWidth: 0.55, // x head width: with no room above the head the cloud shrinks to this first...
    hairOverlap: 0.2, // ...then may sink this far into the hair (x half-height); the forehead starts ~0.46 down
    followTauS: 0.12, // the cloud trails the head a little: reads as floating
    formTauS: 0.3,
    fadeTauS: 0.5,
    disperseS: 0.55, // laugh: puffs fly apart in this long
    screenInTauS: 0.8, // screen-wide rain builds up after the cloud
    screenOutTauS: 0.45,
    farShare: 0.65, // share of screen rain in the far layer (behind the head)
  },

  fireworks: {
    volleyBursts: 3,
    volleyStaggerMs: 130,
    intervalMs: [900, 450], // relaxed laugh -> big laugh
    speed: [200, 430], // px/s at a 700 px screen; scaled for others
    ttl: [1.1, 1.9],
    firstFlightS: 0.26, // the first rocket of a laugh: fast, so the payoff is quick
    flightS: [0.36, 0.5],
    finaleAfterMs: 2600, // laughing this long: golden willows over the head
    maxFlashesPerSec: 3, // WCAG 2.3.1
    light: { max: 0.085, add: 0.05, tauS: 0.22 }, // scene glow; < 10% luminance change is not a "flash"
  },

  // Quality tiers. The governor moves between them based on measured frame time.
  tiers: [
    { name: 'low', maxParticles: 1200, rainPer1000px: 120, cloudDrops: 70, sparksPerBurst: 60, trailRate: 4, dprCap: 1.25 },
    { name: 'mid', maxParticles: 2600, rainPer1000px: 200, cloudDrops: 110, sparksPerBurst: 100, trailRate: 8, dprCap: 1.75 },
    { name: 'high', maxParticles: 5000, rainPer1000px: 280, cloudDrops: 150, sparksPerBurst: 150, trailRate: 12, dprCap: 2 },
  ],
  governor: {
    downAfterMs: 1500, // frame interval above budget for this long -> drop a tier
    upAfterMs: 6000,
    budgetMs: 22, // ~45 fps floor before we shed load
    headroomMs: 18,
    workBudgetMs: 14, // our JS (inference + physics + draw) per frame
  },
};

// Firework colours: [main, accent]. GOLD and LOVE are for willow and heart shells.
export const PALETTES = [
  [[37, 244, 238], [210, 255, 252]], // cyan
  [[254, 44, 85], [255, 190, 205]], // red-pink
  [[255, 196, 64], [255, 120, 40]], // gold
  [[160, 110, 255], [230, 205, 255]], // violet
  [[120, 255, 160], [230, 255, 205]], // green
];
export const GOLD = [[255, 196, 92], [255, 236, 170]];
export const LOVE = [[255, 74, 128], [255, 196, 214]];
