// What a hero's mouth does while it speaks. Voice lines carry their phonemes (the sound's sentence:
// when each sound of speech starts and ends, by its IPA code point), and the game turns each
// phoneme into flex controller settings (expressions/heroes/phonemes.txt, the "phonemes" class
// client.dll loads for heroes), which the model's flex rules make into morph targets (flex.js).
// sounds.js writes, to the sounds dataset:
//   sounds/<folder>/phonemes.json   { "<sound name>": [start, end, code, start, end, code, ...] }
//     or, for a sound that also has a morph animation baked in (version 5 sounds, m_morphData),
//     { p: [...phonemes], m: { t: [time, ...], h: [channel name hash, ...], s: [[value per channel], ...] } }
//     (a channel's hash is MurmurHash2 of its lower-case controller name, seed 0x31415926)
//   expressions/heroes/phonemes.json { keys: [controller, ...], phonemes: { code: [[key, value], ...] } }
//   phonemes.json                    the folders that have a phonemes.json
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeVpk } = require("./vpk-writer");
const { parse } = require("./kv3");

const FOLDER_FILE = "phonemes.json";
const CLASSES_FILE = "expressions/heroes/phonemes.txt";

// The phonemes of a compiled sound (vsnd_c up to version 4, as Source2Viewer's Sound.cs reads its
// DATA block): [start, end, code, ...], or null when it has none
function sentenceOf(buffer) {
  if (!buffer || buffer.length < 16) return null;
  const version = buffer.readUInt16LE(6);
  if (version > 4) return null;
  const blocksStart = 8 + buffer.readUInt32LE(8);
  const blockCount = buffer.readUInt32LE(12);
  let data = -1;
  for (let i = 0; i < blockCount; i++) {
    const block = blocksStart + i * 12;
    if (buffer.toString("ascii", block, block + 4) === "DATA" && buffer.readUInt32LE(block + 8) > 0) {
      data = block + 4 + buffer.readUInt32LE(block + 4);
    }
  }
  if (data < 0) return null;
  // Format (4 bytes), loop start, sample count, duration, then CResourcePointer<CSentence_t>
  const sentencePosition = data + 16;
  const sentenceOffset = buffer.readUInt32LE(sentencePosition);
  if (!sentenceOffset) return null;
  const sentence = sentencePosition + sentenceOffset;
  // Voice duck byte and padding, then CResourceArray<CBasePhonemeTag_t>
  const phonemesPosition = sentence + 4;
  const count = buffer.readInt32LE(phonemesPosition + 4);
  if (count <= 0) return null;
  const tags = [];
  for (let i = 0; i < count; i++) {
    const tag = phonemesPosition + buffer.readInt32LE(phonemesPosition) + i * 12;
    tags.push(round(buffer.readFloatLE(tag)), round(buffer.readFloatLE(tag + 4)), buffer.readUInt16LE(tag + 8));
  }
  return tags;
}

// The phoneme class (a Source expression file, phonemes.txt): "$keys" names the controllers, each
// phoneme line gives its name, its code (a character or 0x code point) and per key a value and,
// with "$hasweighting", a weight the visemes don't use. Keys at 0 are left out.
function phonemeClasses(text) {
  const keys = [];
  const phonemes = {};
  let weighted = false;
  for (const line of text.split(/\r?\n/)) {
    const words = line.match(/"[^"]*"|\S+/g) ?? [];
    if (words[0] === "$keys") keys.push(...words.slice(1));
    else if (words[0] === "$hasweighting") weighted = true;
    else if (words[0]?.startsWith('"') && words.length > 2) {
      const code = words[1].replace(/"/g, "");
      const point = /^0x/i.test(code) ? parseInt(code, 16) : code.codePointAt(0);
      const values = words.slice(2, 2 + keys.length * (weighted ? 2 : 1)).map(Number);
      const settings = [];
      keys.forEach((_, key) => {
        const value = values[key * (weighted ? 2 : 1)];
        if (value) settings.push([key, value]);
      });
      phonemes[point] = settings;
    }
  }
  return { keys, phonemes };
}

const round = (value) => Math.round(value * 1000) / 1000;

// Version 5 sounds keep their sentence in the CTRL block (binary KV3): Source2Viewer prints it.
// { "<file>": entry or null } for the version 5 sounds among `buffers` (Map of file to its bytes)
function ctrlSentences(buffers, decompiler, work) {
  const result = {};
  const v5 = new Map([...buffers].filter(([, buffer]) => buffer && buffer.length >= 16 && buffer.readUInt16LE(6) === 5));
  if (!v5.size) return result;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const pack = path.join(work, "sounds.vpk");
  writeVpk(pack, v5);
  const printed = spawnSync(decompiler, ["-i", pack, "-e", "vsnd_c", "-b", "CTRL"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (printed.error) throw printed.error;
  // One file alone is printed without its "[1/1] name" line
  const chunks = v5.size === 1 ? [`${[...v5.keys()][0]}\n${printed.stdout}`] : printed.stdout.split(/\n\[\d+\/\d+\] /).slice(1);
  for (const chunk of chunks) {
    const name = chunk.slice(0, chunk.indexOf("\n")).trim();
    const start = chunk.indexOf("<!-- kv3");
    result[name] = null;
    if (start < 0) continue;
    try {
      const sentence = parse(chunk.slice(start)).m_vSound?.m_Sentences?.[0];
      const tags = (sentence?.m_RunTimePhonemes ?? []).flatMap((tag) => [round(tag.m_flStartTime), round(tag.m_flEndTime), tag.m_nPhonemeCode]);
      const morph = sentence?.m_morphData;
      if (morph?.m_samples?.length && morph.m_nameHashCodes?.length) {
        result[name] = { p: tags, m: { t: morph.m_times.map(round), h: morph.m_nameHashCodes, s: morph.m_samples.map((row) => row.map(round)) } };
      } else if (tags.length) {
        result[name] = tags;
      }
    } catch (error) {
      console.log(`  Sentence of ${name} not read: ${error.message}`);
    }
  }
  return result;
}

// Writes <dist>/<folder>/phonemes.json for each folder ({ folder: { name: tags } }); returns the
// files to upload
function writePhonemes(folders, distDir) {
  return Object.entries(folders).map(([folder, sounds]) => {
    const datasetPath = `${folder}/${FOLDER_FILE}`;
    const file = path.join(distDir, datasetPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sounds));
    return { path: datasetPath, file };
  });
}

module.exports = { sentenceOf, ctrlSentences, phonemeClasses, writePhonemes, FOLDER_FILE, CLASSES_FILE };
