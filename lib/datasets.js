// The Hugging Face datasets this tracker writes, named once: renaming a dataset is one line here
// (the variables let a test run write elsewhere). hf.js refuses any dataset not in this list, so
// nothing else (a stray argument, a typo) ever becomes a dataset.
const DATASETS = {
  data: process.env.HF_DATA_REPO || "dota2-data",
  images: process.env.HF_IMAGES_REPO || "dota2-images",
  videos: process.env.HF_VIDEOS_REPO || "dota2-videos",
  models: process.env.HF_REPO || "dota2-models",
  textures: process.env.HF_TEXTURES_REPO || "dota2-textures",
  particles: process.env.HF_PARTICLES_REPO || "dota2-particles",
  sounds: process.env.HF_SOUNDS_REPO || "dota2-sounds",
  maps: process.env.HF_MAPS_REPO || "dota2-maps",
};

module.exports = { DATASETS, NAMES: [...new Set(Object.values(DATASETS))] };
