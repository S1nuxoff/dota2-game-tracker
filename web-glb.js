const zlib = require("zlib");
const { dedup, resample, prune } = require("@gltf-transform/functions");

// The site's copy of a model: <model>.glb.gz next to the full <model>.glb. Gunzipped it is a valid
// glb, the same model with what changes nothing on screen taken out. The game's exports give every
// animation channel its own time accessor and a track for every bone in every clip, scale included,
// so animated models are mostly glTF JSON (Hoodwink: 119 MB, 42 MB of it JSON, 61 MB animation);
// this one is 9 MB.

const EPSILON = 1e-5;

const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < EPSILON);

// A channel that holds its node at the node's own transform for the whole clip. Without it the
// node stays there anyway (three.js puts back the original value of a property no action moves)
function holdsRest(channel) {
  const path = channel.getTargetPath();
  const node = channel.getTargetNode();
  const output = channel.getSampler()?.getOutput();
  if (!node || !output || path === "weights") {
    return false;
  }
  const values = output.getArray();
  const size = output.getElementSize();
  for (let i = size; i < values.length; i++) {
    if (Math.abs(values[i] - values[i % size]) > EPSILON) {
      return false;
    }
  }
  const first = Array.from(values.slice(0, size));
  if (path === "scale") return close(first, node.getScale());
  if (path === "translation") return close(first, node.getTranslation());
  // q and -q are the same rotation
  const rest = node.getRotation();
  return close(first, rest) || close(first, rest.map((value) => -value));
}

// Drops the channels that hold their node at rest. A node keeps one channel when every one of
// its channels would go (the site takes the bones with tracks as the animated ones, for cloth),
// and a clip keeps one when all of its would (a clip's length comes from its tracks)
function dropRestChannels(document) {
  const animations = document.getRoot().listAnimations();
  const keptNodes = new Set();
  const candidates = [];
  for (const animation of animations) {
    for (const channel of animation.listChannels()) {
      if (holdsRest(channel)) {
        candidates.push({ animation, channel });
      } else {
        keptNodes.add(channel.getTargetNode());
      }
    }
  }
  const left = new Map(animations.map((animation) => [animation, animation.listChannels().length]));
  for (const { animation, channel } of candidates) {
    const node = channel.getTargetNode();
    if (left.get(animation) <= 1 || !keptNodes.has(node)) {
      keptNodes.add(node);
      continue;
    }
    const sampler = channel.getSampler();
    channel.dispose();
    sampler.dispose();
    left.set(animation, left.get(animation) - 1);
  }
}

// io: a NodeIO with the extensions registered; returns the gzipped glb
async function webGlb(io, document) {
  dropRestChannels(document);
  await document.transform(
    dedup({ propertyTypes: ["Accessor"] }),
    // Keyframes that linear (slerp for rotations) interpolation gives back anyway
    resample({ tolerance: EPSILON }),
    prune({ propertyTypes: ["Accessor", "BufferView"], keepAttributes: true, keepIndices: true })
  );
  return zlib.gzipSync(await io.writeBinary(document), { level: 9 });
}

module.exports = { webGlb };
