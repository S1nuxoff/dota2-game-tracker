// When each sound plays, for the download site's Sounds pages: catalog/sounds.json, built by catalog.js.
//
// The game picks a voice line by talker rules (scripts/talker/response_rules_*.vrr): a rule needs a
// concept (TLK_DOTA_KILL: the hero killed someone) and conditions (the victim is Pudge, a 25% chance,
// the Jungle Axe voice is worn), and speaks one of its sound events, each one naming its files in
// soundevents.json. Every other sound is known by its event's name alone (Hero_Axe.Berserkers_Call).
//
//   {
//     concepts: [label], conditions: [label],
//     rules: [[concept index, [condition index]]],
//     files: { <sound path>: [event name, [rule index]] }
//   }
const path = require("path");

// The talker's concepts, in words (scripts/talker/response_rules_shared.vrr names them TLK_DOTA_*)
const CONCEPTS = {
  TLK_DOTA_SPAWN: "Spawn",
  TLK_DOTA_MOVE: "Move order",
  TLK_DOTA_ATTACK: "Attack order",
  TLK_DOTA_CAST_ORDER: "Cast order",
  TLK_DOTA_CAST_EXECUTE: "Casting an ability",
  TLK_DOTA_DEATH: "Death",
  TLK_DOTA_KILL: "Killing a hero",
  TLK_DOTA_RESPAWN: "Respawn",
  TLK_DOTA_SELECT: "Picked",
  TLK_DOTA_PURCHASE: "Buying an item",
  TLK_DOTA_IMMORTALITY: "Picking up the Aegis",
  TLK_DOTA_DENY: "Denying",
  TLK_DOTA_LAST_HIT: "Last hit",
  TLK_DOTA_DEFEAT: "Defeat",
  TLK_DOTA_VICTORY: "Victory",
  TLK_DOTA_BOTTLING: "Bottling a rune",
  TLK_DOTA_POWERUP: "Taking a rune",
  TLK_DOTA_PAIN: "Pain",
  TLK_DOTA_CUSTOM: "Special",
  TLK_DOTA_ACK: "Acknowledge",
  TLK_DOTA_LEVELUP: "Level up",
  TLK_DOTA_LEVEL_ABILITY: "Learning an ability",
  TLK_DOTA_LEARN: "Learning an ability",
  TLK_DOTA_NO_MANA: "Not enough mana",
  TLK_DOTA_COOLDOWN: "Ability on cooldown",
  TLK_DOTA_INTHEBAG: "Kill in the bag",
  TLK_DOTA_TAUNT: "Taunt",
  TLK_DOTA_THANKS: "Thanks",
  TLK_DOTA_ITEMDROP: "Item drop",
  TLK_DOTA_LANE_MISSING: "Enemy missing",
  TLK_DOTA_EMOTE: "Emote",
  TLK_DOTA_SHOPPING: "Shopping",
  TLK_DOTA_FOLLOWUP_POSITIVE: "Follow-up, good",
  TLK_DOTA_FOLLOWUP_NEGATIVE: "Follow-up, bad",
  TLK_DOTA_FOLLOWUP_NEGATIVE_ONGOING: "Follow-up, bad",
  TLK_DOTA_FOLLOWUP_GENERIC: "Follow-up",
  TLK_DOTA_ALLY_NEARBY: "Ally nearby",
  TLK_DOTA_ENEMY_NEARBY: "Enemy nearby",
  TLK_DOTA_SUMMON_DIED: "Summon died",
};

const words = (s) =>
  s
    .replace(/^(Is|Has)(?=[A-Z_])/, (m) => (m === "Has" ? "Has " : ""))
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/(?<=\s)[A-Z](?=[a-z])/g, (c) => c.toLowerCase());

// A condition in words, or null for one that only says who speaks (classname: the speaker itself)
function conditionLabel(req, { heroName, itemName, abilityName }) {
  const key = (req.m_matchKey || "").toLowerCase();
  const expr = String(req.m_matchExpr ?? "");
  const chance = /^Chance_(\d+)%$/.exec(req.m_name);
  if (key === "classname") return null;
  if (chance) return `${chance[1]}% chance`;
  if (/^npc_dota_hero_/.test(expr)) {
    const who = heroName(expr) || words(expr.slice(14));
    if (key === "nearby_ally") return `Ally nearby: ${who}`;
    return `Target: ${who}`;
  }
  if (key === "abilityname") return `Ability: ${abilityName(expr) || words(expr)}`;
  if (key === "itemname") return `Item: ${itemName(expr) || words(expr.replace(/^item_/, ""))}`;
  if (key === "customresponse") return `Voice: ${expr.replace(/_/g, " ").replace(/[a-z]/g, (c) => c.toUpperCase())}`;
  if (key === "level" && /^\d+$/.test(expr)) return `Level ${expr}`;
  return words(req.m_name);
}

// rules: the parsed .vrr files ({ m_Requirements, m_ResponseGroups }); events: soundevents.json;
// sounds: the set of dota2-sounds' files; names: lookups of the game's names
function soundRules(rules, events, sounds, names) {
  const requirements = new Map();
  for (const file of rules) for (const req of file.m_Requirements || []) if (!requirements.has(req.m_name)) requirements.set(req.m_name, req);
  const eventFiles = new Map(Object.entries(events).map(([k, v]) => [k.toLowerCase(), v.files || []]));

  const concepts = [];
  const conditions = [];
  const indexOf = (list, label) => {
    let i = list.indexOf(label);
    if (i < 0) i = list.push(label) - 1;
    return i;
  };
  const ruleIndex = new Map();
  const outRules = [];
  const files = {};
  for (const file of rules) {
    for (const group of file.m_ResponseGroups || []) {
      const reqs = (group.m_pEmbeddedRule?.m_Requirements || []).map((n) => requirements.get(n)).filter(Boolean);
      const concept = reqs.find((r) => (r.m_matchKey || "").toLowerCase() === "concept");
      if (!concept) continue;
      const conceptLabel = CONCEPTS[concept.m_matchExpr] || words(concept.m_name);
      const conds = reqs
        .filter((r) => r !== concept)
        .map((r) => conditionLabel(r, names))
        .filter(Boolean);
      const sig = JSON.stringify([conceptLabel, conds]);
      if (!ruleIndex.has(sig)) {
        ruleIndex.set(sig, outRules.length);
        outRules.push([indexOf(concepts, conceptLabel), conds.map((c) => indexOf(conditions, c))]);
      }
      const rule = ruleIndex.get(sig);
      for (const r of group.m_responses || []) {
        // SPEAK names a sound event, SCENE a choreography scene named like one (scenes/axe/<event>.vcd)
        const event = r.m_type === "SCENE" ? path.posix.basename(r.m_value || "", ".vcd") : r.m_value;
        for (const f of eventFiles.get((event || "").toLowerCase()) || []) {
          if (!sounds.has(f)) continue;
          const entry = (files[f] ??= [event, []]);
          if (!entry[1].includes(rule)) entry[1].push(rule);
        }
      }
    }
  }
  // Every other sound: its event's name; of the events playing one file, the one sharing most words
  // with it (berserkers_call.wav: Hero_Axe.Berserkers_Call, not Hero_Axe.Pick)
  const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const score = (event, f) => {
    const name = new Set(tokens(path.posix.basename(f)));
    return tokens(event).filter((t) => name.has(t)).length;
  };
  for (const [event, v] of Object.entries(events)) {
    for (const f of v.files || []) {
      if (!sounds.has(f) || (files[f] && files[f][1].length)) continue;
      if (!files[f] || score(event, f) > score(files[f][0], f)) files[f] = [event, []];
    }
  }
  return { concepts, conditions, rules: outRules, files };
}

module.exports = { soundRules };
