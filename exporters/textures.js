// Every texture of the game outside its interface, on its own, for anyone's renders and the download
// site: the surfaces, normal maps and masks of the heroes, items, units, buildings, props and maps
// (materials/, models/, maps/, ...; the 3D files already hold theirs inside). The <user>/dota2-textures
// dataset, at the game's paths: <path>.png for <path>.vtex_c, the pixels the game draws (decoded from
// the GPU's block compression by Source2Viewer; the full size, not the smaller mip levels). Same
// workings as images.js: only what changed (state/textures.json), batches sent as they are made.
//
//   HF_TOKEN=... node exporters/textures.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force] [--limit N]
//   HF_TOKEN=... node exporters/textures.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
const { main } = require("./images");

main({
  label: "textures",
  dataset: process.env.HF_TEXTURES_REPO || "dota2-textures",
  stateFile: "state/textures.json",
  temp: "./temp/textures",
  // Every texture but the interface's pictures (dota2-images)
  files: /^(?!panorama\/).+\.vtex_c$/,
});
