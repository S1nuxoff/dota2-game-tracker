// items_game (scripts/items/items_game.txt), read from the game: { items_game: { items, prefabs,
// ... } }, a key a block repeats keeping every value, the next ones as "<key>#2" (items' visuals
// repeat "asset_modifier"), as gamefiles.js puts it in dota2-data. An items_game.json next to the
// scripts is read instead (a fixed or older copy for a local run).
const fs = require("fs");
const { parse } = require("./keyvalues");

const FILE = "scripts/items/items_game.txt";
const loaded = new WeakMap();

function loadItemsGame(source) {
  if (fs.existsSync("items_game.json")) {
    console.log("Reading items_game.json");
    return Promise.resolve(JSON.parse(fs.readFileSync("items_game.json", "utf8")));
  }
  if (!loaded.has(source)) {
    loaded.set(
      source,
      (async () => {
        const files = new Map();
        await source.readFiles([FILE], files);
        return parse(files.get(FILE), { raw: true }).root;
      })()
    );
  }
  return loaded.get(source);
}

module.exports = { loadItemsGame };
