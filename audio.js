// What Dotadex needs to play the game's sounds, from the game files:
//   data/animsounds.json      sounds heroes' animations play: { model: { animation: [[cycle, event], ...] } }
//   data/voices/<hero>.json   a hero's voice lines: [{ event, files }]
//   data/portrait-speech.json what heroes say as they come onto their page: the response rules
//                             (scripts/talker/*.vrr) whose groups need a special_spawn, which the
//                             loadout spawn's AE_CL_SPEECH event sets: [{ when: [[key, expr]], lines }]
//   data/audio-library.json   announcer packs and music packs with their files
//   data/ui-sounds.json       the menu's sounds whole: the interface's events and each music pack's
//                             menu music with every field their stacks read, the stacks' defaults,
//                             and the mixer's groups and levels
//   soundevents.json          (sounds dataset) every sound event with its files, volume and pitch
//
//   abilitysounds.json        (data) the sounds and voice lines of each hero's abilities
//
//   HF_TOKEN=... node audio.js <steam user> <password>            (in GitHub Actions)
//   HF_TOKEN=... node audio.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force]
//
// Runs only when the game changed since the last run (audio-state.json).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const hf = require("./hf");
const { localSource, steamSource } = require("./source");
const { parse } = require("./keyvalues");
const kv3 = require("./kv3");

const temp = "./temp/audio";
const STATE_FILE = "audio-state.json";
// Raised when what this writes changes, so the next run writes it all again without a patch
const FORMAT = 4;
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(args) {
  const result = spawnSync(DECOMPILER, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  return result.stdout;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

// { "Hero_Pudge.Attack": { files, volume, pitch, layers } } from a decompiled .vsndevts
function parseSoundEvents(text, events) {
  const pattern = /^\t([\w.\-/]+) =\s*\{([\s\S]*?)^\t\}/gm;
  const names = [];
  for (const [, name, body] of text.matchAll(pattern)) {
    // (music packs write their paths with backslashes)
    const files = [...body.matchAll(/"(sounds[\\/][^"]+)\.vsnd"/g)].map((match) => match[1].replace(/\\+/g, "/"));
    const number = (key) => {
      const value = body.match(new RegExp(`^\\t\\t${key} = ([-\\d.]+)`, "m"))?.[1];
      return value === undefined ? undefined : Number(value);
    };
    const layers = [...body.matchAll(/^\t\tsoundevent_layer\d+ = "([^"]+)"/gm)].map((match) => match[1]);
    if (files.length || layers.length) {
      events[name] = { files, volume: number("volume"), pitch: number("pitch"), ...(layers.length && { layers }) };
      names.push(name);
    }
  }
  return names;
}

// Sound events of each animation, from the model's printed blocks:
// an animation's m_name (three tabs in) comes before its m_eventArray
function animationSounds(text) {
  const result = {};
  let animation = null;
  let cycle = null;
  let inEvents = false;
  for (const line of text.split("\n")) {
    const name = line.match(/^\t\t\tm_name = "([^"]+)"/);
    if (name) {
      animation = name[1];
      continue;
    }
    if (/^\t\t\tm_eventArray =/.test(line)) {
      inEvents = true;
      continue;
    }
    if (inEvents && /^\t\t\t[^\t]/.test(line) && !/^\t\t\t[[\]]/.test(line)) {
      inEvents = false;
    }
    if (!inEvents) {
      continue;
    }
    const at = line.match(/m_flCycle = ([\d.]+)/);
    if (at) {
      cycle = Number(at[1]);
      continue;
    }
    const sound = line.match(/^\t{6}name = "([^"]+)"/);
    if (sound && animation && cycle !== null) {
      (result[animation] ??= []).push([cycle, sound[1]]);
      cycle = null;
    }
  }
  return result;
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const upload = !process.argv.includes("--no-upload");
  if ((!game && !(username && password)) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node audio.js <steam user> <password> | --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force]');
    process.exit(1);
  }
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  const { vpkDir } = source;
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  // Each sound by the path it has in the sounds dataset, MP3 or WAV, so the site asks for the
  // file that is there. Sounds the dataset did not have yet (sounds.js failed or ran after) are
  // left out and kept in the state: once any of them is there, the lists are made again.
  let soundPaths = null;
  if (state.manifest === source.manifestId && state.format === FORMAT && !process.argv.includes("--force")) {
    if (state.missing?.length) {
      soundPaths = await hf.soundPaths(process.env.HF_TOKEN);
    }
    if (!state.missing?.some((file) => soundPaths.has(file))) {
      console.log(`Game unchanged (manifest ${source.manifestId}), nothing to do.`);
      source.release();
      return;
    }
    console.log("Sounds the lists left out are in the dataset now, making them again");
  }

  // The game files these tables are read from, written out loose for Source2Viewer
  const looseDir = path.join(temp, "loose");
  const writeLoose = (files) => {
    for (const [file, buffer] of files) {
      fs.mkdirSync(path.dirname(path.join(looseDir, file)), { recursive: true });
      fs.writeFileSync(path.join(looseDir, file), buffer);
    }
  };

  // Heroes: their model and voice file
  const npc = new Map();
  await source.readFiles(
    vpkDir.files.filter((file) => file.startsWith("scripts/npc/heroes/") || file === "scripts/npc/npc_heroes.txt"),
    npc
  );
  const heroes = {};
  for (const buffer of npc.values()) {
    for (const [key, hero] of Object.entries(parse(buffer).root.DOTAHeroes ?? {})) {
      if (key.startsWith("npc_dota_hero_") && key !== "npc_dota_hero_base" && hero.Model) {
        const abilities = Array.from({ length: 9 }, (_, index) => hero[`Ability${index + 1}`]).filter(
          (name) => name && name !== "generic_hidden" && !name.startsWith("special_bonus")
        );
        heroes[key] = { model: hero.Model.toLowerCase(), voice: hero.VoiceFile?.toLowerCase(), soundSet: hero.SoundSet, abilities };
      }
    }
  }

  // Sound events
  const eventsDir = path.join(temp, "events");
  const eventFiles = new Map();
  await source.readFiles(
    vpkDir.files.filter((file) => file.startsWith("soundevents/") && file.endsWith(".vsndevts_c")),
    eventFiles
  );
  writeLoose(eventFiles);
  run(["-i", path.join(looseDir, "soundevents"), "--recursive", "-o", path.join(eventsDir, "soundevents"), "-d", "--threads", "8"]);
  const events = {};
  const eventsByFile = {};
  for (const file of walk(eventsDir)) {
    if (file.endsWith(".vsndevts")) {
      const relative = path.relative(eventsDir, file).split(path.sep).join("/");
      eventsByFile[relative] = parseSoundEvents(fs.readFileSync(file, "utf8"), events);
    }
  }
  console.log(`${Object.keys(events).length} sound events`);

  soundPaths ??= await hf.soundPaths(process.env.HF_TOKEN);
  const missing = new Set();
  const inDataset = (files) => {
    // Only sounds the game has can still come
    files.filter((file) => !soundPaths.has(file) && vpkDir.tree[`${file}.vsnd_c`]).forEach((file) => missing.add(file));
    return files.map((file) => soundPaths.get(file)).filter(Boolean);
  };
  for (const event of Object.values(events)) {
    event.files = inDataset(event.files);
  }

  const out = path.join(temp, "out");
  const write = (name, value) => {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return { path: name, file };
  };

  // Voice lines per hero, from the voice file its data names
  const voices = [];
  for (const [key, hero] of Object.entries(heroes)) {
    const names = eventsByFile[hero.voice] ?? eventsByFile[`soundevents/voscripts/game_sounds_vo_${key.replace("npc_dota_hero_", "")}.vsndevts`];
    if (names?.length) {
      const lines = names.map((name) => ({ event: name, files: events[name].files })).filter((line) => line.files.length);
      voices.push(write(`data/voices/${key}.json`, lines));
    }
  }
  console.log(`Voice lines for ${voices.length} heroes`);

  // Announcer and music packs, by folder
  const library = { announcers: {}, music: {} };
  for (const file of vpkDir.files) {
    const announcer = file.match(/^sounds\/vo\/(announcer[^/]*)\/.+\.vsnd_c$/);
    const music = file.match(/^sounds\/music\/([^/]+)\/.+\.vsnd_c$/);
    const [sound] = announcer || music ? inDataset([file.replace(/\.vsnd_c$/, "")]) : [];
    if (sound && announcer) {
      (library.announcers[announcer[1]] ??= []).push(sound);
    } else if (sound && music) {
      (library.music[music[1]] ??= []).push(sound);
    }
  }
  console.log(`${Object.keys(library.announcers).length} announcer packs, ${Object.keys(library.music).length} music packs`);

  // The menu's sounds as the game plays them. Panorama's stylesheets name the interface's events
  // (soundevents_dota_ui); the menu music is each music pack's <pack>.music.ui_* events. Each event
  // keeps every field (block_time, soundevent_01.., weights, panner_mode, mixgroup...): its type is
  // a sound stack, whose public fields give what an event leaves out (the volume of ui_main, the
  // panner's curves). The mixer (scripts/soundmixers.txt) sorts a sound into a group by its path,
  // the highest priority match, and Default_Mix gives each group's level.
  const uiEvents = {};
  for (const [file, names] of Object.entries(eventsByFile)) {
    const menu = file === "soundevents/soundevents_dota_ui.vsndevts";
    const pack = /^soundevents\/music\/[^/]+\/soundevents_music\.vsndevts$/.test(file);
    if (!menu && !pack) continue;
    const fields = kv3.parse(fs.readFileSync(path.join(eventsDir, file), "utf8"));
    for (const [name, event] of Object.entries(fields)) {
      if (!menu && !/\.music\.ui_/.test(name)) continue;
      const { vsnd_files, vsnd_duration, ...rest } = event;
      // file by file, so the weights stay with their files when one is not in the dataset
      const listed = [vsnd_files ?? []].flat().map((file) => file.replace(/\\+/g, "/").replace(/\.vsnd$/, ""));
      const found = listed.map((file) => inDataset([file])[0]);
      const files = found.filter(Boolean);
      if (Array.isArray(rest.weights)) rest.weights = rest.weights.filter((_, index) => found[index]);
      uiEvents[name] = { ...rest, files };
    }
  }
  const stackFiles = new Map();
  await source.readFiles(
    vpkDir.files.filter((file) => (file.startsWith("soundstacks/") && file.endsWith(".vsndstck_c")) || file === "scripts/soundmixers.txt"),
    stackFiles
  );
  writeLoose(stackFiles);
  const stacksDir = path.join(temp, "stacks");
  run(["-i", path.join(looseDir, "soundstacks"), "--recursive", "-o", path.join(stacksDir, "soundstacks"), "-d", "--threads", "8"]);
  const usedTypes = new Set(Object.values(uiEvents).map((event) => event.type));
  const stacks = {};
  for (const file of walk(stacksDir)) {
    if (!file.endsWith(".vsndstck")) continue;
    for (const [name, stack] of Object.entries(kv3.parse(fs.readFileSync(file, "utf8")))) {
      const variables = usedTypes.has(name) && stack.operators?.find((operator) => operator.name === "public")?.operator_variables;
      if (!variables) continue;
      stacks[name] = {};
      for (const [key, variable] of Object.entries(variables)) {
        const value = variable?.value;
        if (value === undefined || typeof value === "object" && !Array.isArray(value)) continue;
        // numbers and curves come as text ("0.5", "[ -0.5, -1.0, ... ]")
        const parsed = (text) => (typeof text === "string" && /^[-\d.]+f?$/.test(text.trim()) ? Number(text.replace(/f$/, "")) : text);
        stacks[name][key] = Array.isArray(value)
          ? value.map((entry) => (typeof entry === "string" && entry.trim().startsWith("[") ? entry.replace(/[[\]]/g, "").split(",").filter((part) => part.trim()).map(Number) : parsed(entry)))
          : parsed(value);
      }
    }
  }
  const mixers = kv3.parse(stackFiles.get("scripts/soundmixers.txt").toString("utf8"));
  const uiSounds = {
    events: uiEvents,
    stacks,
    mix: {
      groups: mixers.MixGroups.map((group) => ({ name: group.name, path: group.path_substring, class: group.class_substring, priority: group.priority })),
      levels: Object.fromEntries(mixers.SoundMixers.Default_Mix.map((group) => [group.mixgroup, group.vol])),
    },
  };
  console.log(`${Object.keys(uiEvents).length} menu sound events, ${Object.keys(stacks).length} of their stacks`);

  // What a hero says coming onto its page. The loadout spawn's animation speaks (AE_CL_SPEECH,
  // concept TLK_DOTA_CUSTOM, criteria special_spawn=<hero>_loadout_spawn); the hero's response
  // rules pick the group whose requirements all hold (Concept, classname, special_spawn and at
  // times customresponse, "!=" for not), and a line of it. Each group with its requirements
  // as [key, expression] and its lines (sound events; a SCENE's lines are not read yet)
  const talkerFiles = new Map();
  await source.readFiles(vpkDir.files.filter((file) => /^scripts\/talker\/.+\.vrr_c$/.test(file)), talkerFiles);
  writeLoose(talkerFiles);
  source.release();
  const talkerOut = path.join(temp, "talker");
  run(["-i", path.join(looseDir, "scripts", "talker"), "--recursive", "-o", talkerOut, "-d"]);
  const rules = [...walk(talkerOut)].filter((file) => file.endsWith(".vrr")).map((file) => kv3.parse(fs.readFileSync(file, "utf8")));
  const sharedRequirements = {};
  for (const rule of rules) {
    for (const requirement of rule.m_Requirements ?? []) {
      if (requirement?.m_notes === "SHARED") sharedRequirements[requirement.m_name] = requirement;
    }
  }
  const portraitSpeech = [];
  for (const rule of rules) {
    const own = Object.fromEntries((rule.m_Requirements ?? []).map((requirement) => [requirement.m_name, requirement]));
    for (const group of rule.m_ResponseGroups ?? []) {
      const requirements = (group.m_pEmbeddedRule?.m_Requirements ?? []).map((name) => own[name] ?? sharedRequirements[name]);
      if (!requirements.some((requirement) => requirement?.m_matchKey === "special_spawn") || requirements.some((requirement) => !requirement)) continue;
      const lines = (group.m_responses ?? []).filter((response) => response.m_type === "SPEAK" && events[response.m_value]).map((response) => response.m_value);
      if (lines.length) {
        portraitSpeech.push({ when: requirements.map((requirement) => [requirement.m_matchKey, String(requirement.m_matchExpr).trim()]), lines });
      }
    }
  }
  console.log(`${portraitSpeech.length} groups of lines heroes say coming onto their page`);

  // Animation sounds of each hero model
  const models = new Map();
  await source.readFiles(
    Object.values(heroes)
      .map((hero) => `${hero.model}_c`)
      .filter((file) => vpkDir.tree[file]),
    models
  );
  writeLoose(models);
  source.release();
  const animsounds = {};
  for (const [key, hero] of Object.entries(heroes)) {
    const modelFile = path.join(looseDir, `${hero.model}_c`);
    if (!fs.existsSync(modelFile)) {
      continue;
    }
    const text = run(["-i", modelFile, "-a"]);
    const sounds = animationSounds(text);
    if (Object.keys(sounds).length) {
      animsounds[hero.model.replace(/\.vmdl$/, ".glb")] = sounds;
    }
    process.stdout.write(".");
  }
  console.log(`\nAnimation sounds for ${Object.keys(animsounds).length} heroes`);

  // The sounds of each hero's abilities, for casting them in the viewer: the events of the
  // hero's own sound file whose names carry the ability's words ("antimage_mana_void" ->
  // "Hero_Antimage.ManaVoid"), the cast first; and its voice lines for them
  const abilitySounds = {};
  for (const [key, hero] of Object.entries(heroes)) {
    const id = key.replace("npc_dota_hero_", "");
    const heroFile = Object.keys(eventsByFile).find((file) => file.endsWith(`/game_sounds_${id}.vsndevts`));
    const pool = heroFile ? eventsByFile[heroFile] : [];
    const voicePool = eventsByFile[hero.voice] ?? [];
    const result = {};
    for (const ability of hero.abilities) {
      const heroWords = new Set(id.split("_"));
      const words = ability.split("_").filter((word) => word.length > 2 && !heroWords.has(word));
      if (!words.length) {
        continue;
      }
      const joined = words.join("");
      const matches = (name) => {
        const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
        return flat.includes(joined) || words.every((word) => flat.includes(word));
      };
      const sounds = pool
        .filter(matches)
        .sort((a, b) => Number(/cast/i.test(b)) - Number(/cast/i.test(a)) || a.length - b.length)
        .slice(0, 3);
      const lines = voicePool.filter(matches).flatMap((name) => events[name].files);
      if (sounds.length || lines.length) {
        result[ability] = { sounds, lines };
      }
    }
    if (Object.keys(result).length) {
      abilitySounds[key] = result;
    }
  }
  console.log(`Ability sounds for ${Object.keys(abilitySounds).length} heroes`);

  // The events the viewer plays during animations: those the animations name and each
  // hero's attack (the game plays it on the hit, not from the animation), with their
  // layers. Much smaller than all the events.
  const needed = new Set(Object.values(animsounds).flatMap((model) => Object.values(model).flatMap((list) => list.map(([, name]) => name))));
  for (const hero of Object.values(heroes)) {
    if (hero.soundSet) {
      needed.add(`${hero.soundSet}.Attack`);
    }
  }
  const viewerEvents = {};
  const add = (name) => {
    if (events[name] && !viewerEvents[name]) {
      viewerEvents[name] = events[name];
      events[name].layers?.forEach(add);
    }
  };
  needed.forEach(add);
  for (const hero of Object.values(abilitySounds)) {
    for (const ability of Object.values(hero)) {
      ability.sounds.forEach(add);
    }
  }

  const data = [
    write("data/animsounds.json", animsounds),
    write("data/animsound-events.json", viewerEvents),
    write("data/audio-library.json", library),
    write("data/ui-sounds.json", uiSounds),
    write("data/abilitysounds.json", abilitySounds),
    write("data/portrait-speech.json", portraitSpeech),
    ...voices,
  ];
  const soundEvents = write("soundevents.json", events);
  if (upload) {
    const token = process.env.HF_TOKEN;
    await hf.upload(await hf.prepareRepo(token, process.env.HF_REPO), token, data, "Update voice lines and animation sounds");
    await hf.upload(await hf.prepareRepo(token, "dota2-sounds"), token, [soundEvents], "Update sound events");
  } else {
    console.log(`Written to ${out}`);
  }
  if (upload) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ manifest: source.manifestId, format: FORMAT, missing: [...missing].sort() }));
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
