// Generated from the app’s Sprite.tsx by sync-character.mjs.
const COLS = 15;
const ROWS = 11;
const EYE = {
  open: [".#.", "###", "###", ".#."],
  blink: ["...", "...", "###", "..."],
  arc: [".#.", "#.#", "...", "..."],
  wide: ["###", "#.#", "#.#", "###"],
  focus: ["...", "###", "###", "..."],
  sadL: ["...", "##.", "###", ".#."],
  sadR: ["...", ".##", "###", ".#."],
  cross: ["#.#", ".#.", "#.#", "..."],
  heart: ["#.#", "###", ".#.", "..."],
  ringA: ["###", "#.#", "###", "..."],
  ringB: [".#.", "#.#", ".#.", "..."],
  gtL: ["#..", ".#.", "#..", "..."],
  ltR: ["..#", ".#.", "..#", "..."],
  lid: ["...", "...", "###", ".#."],
  star: [".+.", "+++", ".+.", "..."],
  down: ["...", "...", ".#.", "###"],
  none: ["...", "...", "...", "..."]
};
const MOUTH = {
  smile: [".....", "#...#", ".###."],
  grin: ["#####", "#...#", ".###."],
  o: [".....", "..#..", "....."],
  bigO: [".###.", "#...#", ".###."],
  side: [".....", "...##", ".##.."],
  tongue: [".....", "#...#", ".#+#."],
  frown: [".....", ".###.", "#...#"],
  wobbleA: [".....", "#.#.#", ".#.#."],
  wobbleB: [".....", ".#.#.", "#.#.#"],
  flat: [".....", ".###.", "....."],
  sleepA: [".....", "..#..", "....."],
  sleepB: [".....", ".###.", "....."],
  none: [".....", ".....", "....."],
  kiss: ["..#..", "...#.", "..#.."],
  pout: [".....", ".###.", ".#.#."],
  tiny: [".....", ".##..", "....."],
  smirk: [".....", "....#", ".###."],
  laughA: ["#####", "#+++#", ".###."],
  laughB: [".....", "#####", ".###."]
};
const MARK = {
  question: ["###", "..#", ".##", "...", ".#."],
  bang: [".#.", ".#.", ".#.", "...", ".#."],
  z: ["###", ".#.", "###"],
  spark: [".#.", "#.#", ".#."],
  heart: ["#.#", "###", ".#."],
  note: [".##", ".#.", "##."],
  hand: ["#.#", "###", ".#."]
};
function stamp(grid, glyph, col, row, tone = "on", mirror = false) {
  glyph.forEach((line, dy) => {
    for (let dx = 0; dx < line.length; dx++) {
      const ch = mirror ? line[line.length - 1 - dx] : line[dx];
      if (ch === "." || ch === void 0) continue;
      const c = col + dx;
      const r = row + dy;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      grid.set(r * COLS + c, ch === "+" ? "accent" : tone);
    }
  });
}
function dots(g, cells, tone = "on") {
  for (const [c, r] of cells) if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g.set(r * COLS + c, tone);
}
const blush = (g) => dots(g, [[1, 6], [2, 6], [12, 6], [13, 6]], "accent");
const LIME = "#d4ff3a";
const AMBER = "#ffb23e";
const RED = "#ff5a4e";
const PINK = "#ff6fa8";
const ICE = "#8fb4ff";
const scanner = (g, t) => {
  const span = COLS - 3;
  const k = t % (span * 2);
  const at = k < span ? k : span * 2 - k;
  for (let i = 0; i < 3; i++) g.set((ROWS - 1) * COLS + at + i, "accent");
};
const sparkles = (g, t) => {
  if (t % 2 === 0) stamp(g, MARK.spark, 0, 0, "accent");
  else stamp(g, MARK.spark, 12, 0, "accent");
};
const sweat = (g, t) => {
  g.set((t % 3 + 1) * COLS + 13, "accent");
};
const FACES = {
  idle: { eyes: ["open", "open"], mouth: "smile", tracks: true, accent: LIME },
  happy: { eyes: ["arc", "arc"], mouth: "grin", tracks: false, accent: LIME },
  excited: { eyes: ["wide", "wide"], mouth: "bigO", tracks: false, accent: LIME, extra: sparkles },
  listening: { eyes: ["open", "open"], mouth: "o", tracks: true, accent: ICE },
  curious: { eyes: ["wide", "open"], mouth: "side", tracks: true, accent: ICE },
  thinking: {
    eyes: ["open", "open"],
    mouth: "none",
    tracks: false,
    accent: ICE,
    extra: (g, t) => {
      for (let i = 0; i <= t % 4 && i < 3; i++) g.set(8 * COLS + 5 + i * 2, "on");
    }
  },
  working: { eyes: ["focus", "focus"], mouth: "flat", tracks: true, accent: LIME, extra: scanner },
  straining: { eyes: ["focus", "focus"], mouth: "wobbleA", tracks: false, accent: AMBER, extra: (g, t) => {
    scanner(g, t);
    sweat(g, t);
  } },
  waiting: { eyes: ["wide", "wide"], mouth: "o", tracks: true, accent: AMBER, extra: (g, t) => {
    if (t % 4 !== 3) stamp(g, MARK.question, 12, 0, "accent");
  } },
  proud: { eyes: ["arc", "arc"], mouth: "grin", tracks: false, accent: LIME, extra: sparkles },
  sad: { eyes: ["sadL", "sadR"], mouth: "frown", tracks: false, accent: RED, extra: (g, t) => {
    g.set((6 + t % 3) * COLS + 3, "accent");
  } },
  oops: { eyes: ["gtL", "ltR"], mouth: "wobbleA", tracks: false, accent: AMBER, extra: sweat },
  sleepy: { eyes: ["blink", "blink"], mouth: "sleepA", tracks: false, accent: ICE, extra: (g, t) => stamp(g, MARK.z, 12, 2 - t % 3, "accent") },
  dizzy: { eyes: ["ringA", "ringA"], mouth: "wobbleA", tracks: false, accent: AMBER },
  love: { eyes: ["heart", "heart"], mouth: "grin", tracks: false, accent: PINK, extra: (g, t) => {
    if (t % 2) stamp(g, MARK.heart, 12, 0, "accent");
  } },
  surprised: { eyes: ["wide", "wide"], mouth: "bigO", tracks: false, accent: AMBER, extra: (g) => stamp(g, MARK.bang, 12, 0, "accent") },
  wink: { eyes: ["open", "blink"], mouth: "side", tracks: false, accent: LIME },
  // Hello: happy eyes and a little hand going side to side.
  wave: { eyes: ["arc", "arc"], mouth: "grin", tracks: false, accent: LIME, extra: (g, t) => stamp(g, MARK.hand, t % 2 ? 12 : 11, t % 2 ? 4 : 5, "accent") },
  // Squeezed eyes, open mouth, happy tears.
  laugh: {
    eyes: ["gtL", "ltR"],
    mouth: "laughA",
    tracks: false,
    accent: ICE,
    mouthAt: (t) => t % 2 ? "laughB" : "laughA",
    extra: (g, t) => dots(g, [[1, 5 + t % 3], [13, 5 + (t + 1) % 3]], "accent")
  },
  // Looks down and away, cheeks lit.
  shy: { eyes: ["down", "down"], mouth: "tiny", tracks: false, accent: PINK, gaze: () => [-1, 0], extra: blush },
  // Half-lidded, glancing about for something to do.
  bored: { eyes: ["lid", "lid"], mouth: "flat", tracks: false, accent: ICE, gaze: (t) => [[0, -1, 0, 1][t % 4], 0] },
  // A slow, wide yawn.
  yawn: {
    eyes: ["gtL", "ltR"],
    mouth: "o",
    tracks: false,
    accent: ICE,
    mouthAt: (t) => ["o", "bigO", "bigO", "bigO", "o", "flat"][t % 6],
    eyesAt: (t) => t % 6 < 4 ? ["gtL", "ltR"] : ["blink", "blink"]
  },
  // Sunglasses on, smirk.
  cool: {
    eyes: ["none", "none"],
    mouth: "smirk",
    tracks: false,
    accent: LIME,
    extra: (g, t) => {
      dots(g, [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2]]);
      dots(g, [[3, 3], [4, 3], [5, 3], [9, 3], [10, 3], [11, 3], [4, 4], [10, 4]]);
      if (t % 5 === 0) dots(g, [[5, 3]], "accent");
    }
  },
  // Star eyes and sparkles: "that was amazing".
  starstruck: { eyes: ["star", "star"], mouth: "bigO", tracks: false, accent: "#ffe066", extra: sparkles },
  // Eyes closed, humming, a note drifting up.
  music: { eyes: ["arc", "arc"], mouth: "smile", tracks: false, accent: LIME, extra: (g, t) => stamp(g, MARK.note, 12, 3 - t % 4, "accent") },
  // Eyes sweeping along a line of text.
  reading: { eyes: ["focus", "focus"], mouth: "flat", tracks: false, accent: ICE, gaze: (t) => [[-1, 0, 1, 1][t % 4], [0, 0, 0, 1][t % 4]] },
  // One brow up.
  skeptical: {
    eyes: ["open", "focus"],
    mouth: "side",
    tracks: false,
    accent: ICE,
    extra: (g) => dots(g, [[3, 1], [4, 1], [5, 1], [9, 0], [10, 0], [11, 1]])
  },
  // Wide eyes darting, wobbly mouth, sweat.
  nervous: { eyes: ["wide", "wide"], mouth: "wobbleA", tracks: false, accent: AMBER, gaze: (t) => [t % 2 ? -1 : 0, 0], extra: sweat },
  // Confetti falling over a big grin.
  celebrate: {
    eyes: ["arc", "arc"],
    mouth: "grin",
    tracks: false,
    accent: LIME,
    extra: (g, t) => {
      for (const [c, off] of [[0, 0], [2, 3], [7, 1], [12, 2], [14, 4], [5, 5]]) dots(g, [[c, (t + off) % 6]], "accent");
    }
  },
  // A wink and a kiss.
  kiss: { eyes: ["open", "arc"], mouth: "kiss", tracks: false, accent: PINK, extra: (g, t) => {
    if (t % 2) stamp(g, MARK.heart, 12, 5, "accent");
  } },
  // Brows down, lip out.
  pout: {
    eyes: ["open", "open"],
    mouth: "pout",
    tracks: false,
    accent: RED,
    gaze: () => [1, 0],
    extra: (g) => dots(g, [[3, 1], [4, 1], [5, 2], [9, 2], [10, 1], [11, 1]])
  },
  // Ah… ah… choo.
  sneeze: {
    eyes: ["focus", "focus"],
    mouth: "o",
    tracks: false,
    accent: ICE,
    eyesAt: (t) => t % 6 < 3 ? ["focus", "focus"] : t % 6 < 5 ? ["gtL", "ltR"] : ["blink", "blink"],
    mouthAt: (t) => t % 6 < 3 ? "o" : t % 6 < 5 ? "bigO" : "flat",
    extra: (g, t) => {
      if (t % 6 === 4) dots(g, [[1, 7], [0, 8], [2, 9], [13, 7], [14, 8], [12, 9]], "accent");
    }
  },
  // "On it": brows set, a small confident smile.
  determined: {
    eyes: ["focus", "focus"],
    mouth: "smirk",
    tracks: true,
    accent: LIME,
    extra: (g) => dots(g, [[3, 1], [4, 2], [5, 2], [9, 2], [10, 2], [11, 1]])
  }
};
const FRAME_MS = {
  working: 90,
  straining: 70,
  thinking: 380,
  waiting: 420,
  excited: 300,
  proud: 320,
  sad: 500,
  oops: 260,
  sleepy: 900,
  dizzy: 160,
  love: 400,
  wave: 260,
  laugh: 140,
  bored: 900,
  yawn: 380,
  cool: 500,
  starstruck: 280,
  music: 420,
  reading: 520,
  nervous: 180,
  celebrate: 160,
  kiss: 420,
  sneeze: 330,
  shy: 800
};
function faceGrid(mood, t, look, blinking) {
  const face = FACES[mood];
  const grid = /* @__PURE__ */ new Map();
  const fixed = face.gaze?.(t) ?? (mood === "thinking" ? [1, -1] : [0, 0]);
  const dx = face.tracks ? look.x > 0.35 ? 1 : look.x < -0.35 ? -1 : 0 : fixed[0];
  const dy = face.tracks ? look.y > 0.45 ? 1 : look.y < -0.45 ? -1 : 0 : fixed[1];
  const eyes = face.eyesAt?.(t) ?? face.eyes;
  const canBlink = (e) => ["open", "wide", "focus"].includes(e);
  const eye = (name) => name === "ringA" && t % 2 ? "ringB" : blinking && canBlink(name) ? "blink" : name;
  stamp(grid, EYE[eye(eyes[0])], 3 + dx, 2 + dy);
  stamp(grid, EYE[eye(eyes[1])], 9 + dx, 2 + dy);
  let mouth = face.mouthAt?.(t) ?? face.mouth;
  if (mouth === "wobbleA" && t % 2) mouth = "wobbleB";
  if (mouth === "sleepA" && t % 2) mouth = "sleepB";
  stamp(grid, MOUTH[mouth], 5 + (face.tracks ? dx : 0), 7);
  face.extra?.(grid, t);
  return grid;
}
export {
  faceGrid
};
