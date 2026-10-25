// What each model's preview looks like, as numbers, for the download site's search by picture and by
// words: CLIP (MODEL below) turns every previews/<model>.webp of dota2-models into a vector of DIM
// numbers; the site turns a piece of a screenshot (or a few words) into a vector the same way and
// shows the models whose vectors are nearest. Kept next to the previews:
//   previews/embeddings.json  { model, dim, paths: [preview path, ...] }
//   previews/embeddings.bin   per preview, in that order: a float32 scale, then DIM int8 (vector / scale)
// Previews are laid on grey (they are transparent), as a crop of a game scene has some background.
// Only previews new or changed since the last run (state/embeddings.json); the others' vectors are
// read back from the dataset. Runs after previews.js.
//
// --describe prints, for each preview, which of LABELS its vector is nearest to (CLIP names nothing
// itself; it can only say which words fit a picture best), to watch it at work.
//
//   HF_TOKEN=... node exporters/embeddings.js [--no-upload] [--limit N] [--describe]
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const sharp = require("sharp");
const hf = require("../lib/hf");
const { DATASETS } = require("../lib/datasets");

const OWNER = "Sqls1";
const MODEL = "Xenova/clip-vit-base-patch32";
const DTYPE = "q8";
const DIM = 512;
const STATE_FILE = "state/embeddings.json";
const PREFIX = "previews/";
const temp = path.resolve("./temp/embeddings");
const BACKGROUND = { r: 128, g: 128, b: 128 };

// Words for --describe only; the search itself uses whatever people type
const LABELS = [
  "a rock", "a boulder", "a cliff", "a crystal", "a tree", "a pine tree", "a dead tree", "a bush", "grass", "a flower",
  "a mushroom", "a log", "a tree stump", "a vine", "a coral", "a seashell", "a bone", "a skull", "a skeleton", "a ruin",
  "a stone wall", "a column", "a statue", "a tower", "a building", "a house", "a hut", "a tent", "a bridge", "a gate",
  "a fence", "a door", "stairs", "a floor tile", "a banner", "a flag", "a torch", "a lantern", "a candle", "a campfire",
  "a barrel", "a crate", "a chest", "a treasure chest", "a cart", "a wagon", "a boat", "a ship", "an anchor", "a cage",
  "a table", "a chair", "a throne", "a bed", "a bookshelf", "a book", "a scroll", "a potion", "a bottle", "a cauldron",
  "a pot", "a bowl", "food", "a cake", "a sword", "an axe", "a hammer", "a spear", "a bow", "an arrow", "a shield",
  "a staff", "a wand", "a dagger", "a gun", "a cannon", "a helmet", "armor", "shoulder armor", "a cape", "a belt",
  "a glove", "boots", "a mask", "a crown", "hair", "a beard", "wings", "a tail", "horns", "a necklace", "a ring", "a gem",
  "a coin", "a key", "a bell", "a book cover", "a warrior", "a wizard", "a woman", "a man", "a child", "a monster",
  "a demon", "a ghost", "a zombie", "a dragon", "a bird", "an owl", "a horse", "a wolf", "a dog", "a cat", "a bear",
  "a boar", "a goat", "a sheep", "a pig", "a frog", "a snake", "a spider", "a fish", "a crab", "an insect", "a turtle",
  "a lizard", "a golem", "a robot", "a machine", "a gear", "a cloud", "water", "lava", "ice", "snow", "fire", "a planet",
  "a portal", "a rune", "a plane of glass", "a poster", "a painting", "a card", "a sign", "a backdrop", "a cave",
];

const fileUrl = (file) => `https://huggingface.co/datasets/${OWNER}/${DATASETS.models}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function download(file, accessToken) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(fileUrl(file), { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} }).catch(() => null);
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
    if (res && res.status !== 429 && res.status < 500) throw new Error(`${file}: ${res.status}`);
    if (attempt >= 8) throw new Error(`${file}: ${res?.status ?? "no connection"}`);
    await new Promise((r) => setTimeout(r, (Number(res?.headers.get("retry-after")) || 3 * attempt) * 1000));
  }
}

// The vectors made before, by preview path
async function previous(accessToken) {
  try {
    const index = JSON.parse(await download(`${PREFIX}embeddings.json`, accessToken));
    if (index.model !== MODEL || index.dim !== DIM) return new Map();
    const bin = await download(`${PREFIX}embeddings.bin`, accessToken);
    const stride = 4 + DIM;
    return new Map(index.paths.map((p, i) => [p, bin.subarray(i * stride, (i + 1) * stride)]));
  } catch {
    return new Map();
  }
}

// One vector as stored: its largest component sets the scale of the int8s
function pack(vector) {
  let max = 0;
  for (const v of vector) max = Math.max(max, Math.abs(v));
  const scale = max / 127 || 1;
  const out = Buffer.alloc(4 + DIM);
  out.writeFloatLE(scale, 0);
  for (let i = 0; i < DIM; i++) out.writeInt8(Math.round(vector[i] / scale), 4 + i);
  return out;
}

async function main() {
  const accessToken = process.env.HF_TOKEN;
  const upload = !process.argv.includes("--no-upload");
  if (upload && !accessToken) {
    console.error("Usage: HF_TOKEN=... node exporters/embeddings.js [--no-upload] [--limit N]");
    process.exit(1);
  }
  const limit = Number(argValue("--limit")) || Infinity;
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};

  const res = await fetch(`${fileUrl("files.json")}.gz`);
  const files = JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer()))).files;
  const previews = files.filter(([p]) => p.startsWith(PREFIX) && p.endsWith(".webp")).slice(0, limit);
  const old = await previous(accessToken);
  const todo = previews.filter(([p, size]) => state[p] !== size || !old.has(p));
  console.log(`embeddings: ${previews.length} previews, ${todo.length} to look at`);
  if (!todo.length && previews.length === old.size) return;

  const { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(temp, "model");
  const processor = await AutoProcessor.from_pretrained(MODEL);
  const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: DTYPE });

  // For --describe: every label's vector, from CLIP's text side
  let labels = null;
  if (process.argv.includes("--describe")) {
    const { AutoTokenizer, CLIPTextModelWithProjection } = await import("@huggingface/transformers");
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    const text = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: DTYPE });
    const { text_embeds } = await text(tokenizer(LABELS.map((l) => `a 3D model of ${l}`), { padding: true, truncation: true }));
    labels = text_embeds.normalize(2, -1).tolist();
  }
  const describe = (vector) => {
    // CLIP's own way: similarities scaled by its temperature (100), as shares of one
    const scores = labels.map((l) => 100 * l.reduce((sum, v, i) => sum + v * vector[i], 0));
    const top = Math.max(...scores);
    const exp = scores.map((x) => Math.exp(x - top));
    const total = exp.reduce((a, b) => a + b, 0);
    return exp
      .map((e, i) => [e / total, LABELS[i]])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2)
      .map(([p, l]) => `${l} ${Math.round(p * 100)}%`)
      .join(", ");
  };

  const vectors = new Map(old);
  const started = Date.now();
  let done = 0;
  const BATCH = 16;
  // Pictures are fetched ahead while the model looks at the ones before
  const fetchImage = async ([p]) => {
    const { data, info } = await sharp(await download(p, accessToken)).flatten({ background: BACKGROUND }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  };
  let ahead = Promise.all(todo.slice(0, BATCH).map(fetchImage));
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const images = await ahead;
    ahead = Promise.all(todo.slice(start + BATCH, start + 2 * BATCH).map(fetchImage));
    const { image_embeds } = await vision(await processor(images));
    const rows = image_embeds.normalize(2, -1).tolist();
    batch.forEach(([p, size], i) => {
      vectors.set(p, pack(rows[i]));
      state[p] = size;
      if (labels) console.log(`  ${p.slice(PREFIX.length).replace(/\.webp$/, "")}  ->  ${describe(rows[i])}`);
    });
    done += batch.length;
    if (done % 1024 < BATCH) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done}/${todo.length}, ${rate.toFixed(1)}/s, ${Math.round((todo.length - done) / rate / 60)} min left`);
    }
  }

  // Previews gone from the dataset leave
  const paths = previews.map(([p]) => p).filter((p) => vectors.has(p));
  for (const p of Object.keys(state)) if (!paths.includes(p)) delete state[p];
  fs.mkdirSync(temp, { recursive: true });
  const jsonFile = path.join(temp, "embeddings.json");
  const binFile = path.join(temp, "embeddings.bin");
  fs.writeFileSync(jsonFile, JSON.stringify({ model: MODEL, dtype: DTYPE, dim: DIM, background: BACKGROUND, paths }));
  fs.writeFileSync(binFile, Buffer.concat(paths.map((p) => vectors.get(p))));
  console.log(`embeddings: ${paths.length} vectors, ${(fs.statSync(binFile).size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)} s`);
  if (upload) {
    const repo = await hf.prepareRepo(accessToken, DATASETS.models);
    await hf.upload(repo, accessToken, [{ path: `${PREFIX}embeddings.json`, file: jsonFile }, { path: `${PREFIX}embeddings.bin`, file: binFile }], "Update model preview embeddings", { gzip: false });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  }
}

module.exports = { main };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
