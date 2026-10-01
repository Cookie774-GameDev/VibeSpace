import type { NATURE_PROFILE_IDS } from './natureAvatarAssignment';

type ProfileId = (typeof NATURE_PROFILE_IDS)[number];
type Bounds = readonly [left: number, top: number, right: number, bottom: number];

// Dark outline extents measured from the unchanged 1254px originals. These
// affect presentation only: the atlases and source portrait pixels stay intact.
const OUTLINE_BOUNDS: Record<ProfileId, Bounds> = {
  '01-leaf-ghost': [351, 112, 892, 1122],
  '02-acorn': [181, 144, 1072, 1117],
  '03-cloud': [135, 208, 1122, 1127],
  '04-mushroom': [140, 186, 1113, 1095],
  '05-starlight': [136, 134, 1117, 1093],
  '06-candle': [354, 180, 899, 1073],
  '07-pebble': [196, 290, 1071, 1038],
  '08-origami-bird': [79, 190, 1191, 1101],
  '09-moth': [107, 299, 1146, 947],
  '10-teacup': [219, 462, 1102, 1091],
  '11-crescent-moon': [320, 267, 963, 989],
  '12-fern': [331, 129, 921, 1138],
  '13-snowdrop': [253, 187, 973, 1086],
  '14-pinecone': [306, 228, 949, 1050],
  '15-firefly': [282, 319, 1025, 969],
  '16-seashell': [326, 189, 949, 1096],
  '17-jellyfish': [299, 256, 955, 1046],
  '18-coral': [233, 145, 1067, 1117],
  '19-snail': [228, 366, 1040, 947],
  '20-amber': [296, 285, 975, 994],
  '21-ladybug': [272, 336, 1019, 964],
  '22-dandelion': [301, 216, 952, 1080],
  '23-fox-cub': [211, 234, 1107, 1099],
  '24-bunny': [329, 203, 889, 1067],
  '25-otter': [252, 258, 942, 1011],
  '26-hedgehog': [252, 304, 1001, 981],
  '27-fawn': [307, 206, 1004, 1079],
};

// Maximum zoom measured across all 487 animated frames, allowing a 2.5% inset
// from the circular edge. Rest-pose bounds alone clip moving ears, legs, wings
// and tails on several characters.
const CIRCLE_ZOOM: Record<ProfileId, number> = {
  '01-leaf-ghost': 1.009,
  '02-acorn': 1.052,
  '03-cloud': 1.155,
  '04-mushroom': 0.969,
  '05-starlight': 0.999,
  '06-candle': 1.242,
  '07-pebble': 1.114,
  '08-origami-bird': 0.903,
  '09-moth': 1.0,
  '10-teacup': 1.168,
  '11-crescent-moon': 1.464,
  '12-fern': 1.095,
  '13-snowdrop': 1.231,
  '14-pinecone': 1.306,
  '15-firefly': 1.172,
  '16-seashell': 1.187,
  '17-jellyfish': 1.218,
  '18-coral': 1.122,
  '19-snail': 1.214,
  '20-amber': 1.527,
  '21-ladybug': 1.395,
  '22-dandelion': 1.171,
  '23-fox-cub': 0.924,
  '24-bunny': 1.034,
  '25-otter': 1.225,
  '26-hedgehog': 1.315,
  '27-fawn': 0.892,
};

export function natureAvatarFraming(id: ProfileId) {
  const bounds = OUTLINE_BOUNDS[id];
  const [left, top, right, bottom] = bounds;
  const longestSide = Math.max(right - left, bottom - top);
  return {
    bounds,
    // Keep the source silhouette inside both the tile and its circular mask.
    zoom: Math.min(1.38, (1254 * 0.9) / longestSide, CIRCLE_ZOOM[id]),
    focusX: (left + right) / (1254 * 2),
    focusY: (top + bottom) / (1254 * 2),
  };
}
