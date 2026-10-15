// A reader for Valve's KeyValues text (the .txt files in scripts/ and resource/):
// "key" "value" pairs and "key" { ... } blocks, // comments, unquoted tokens,
// [$PLATFORM] conditions (ignored) and #base includes (returned for the caller).
// Repeated keys in a block keep the first value, as the game does.

function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2);
  }
  const text = buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "{" || c === "}") {
      tokens.push(c);
      i++;
    } else if (c === "[") {
      // Conditions like [$WIN32] apply to the previous pair, they are dropped
      while (i < text.length && text[i] !== "]") i++;
      i++;
    } else if (c === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          value += text[i++];
        }
      }
      i++;
      tokens.push({ s: value });
    } else {
      let value = "";
      while (i < text.length && !" \t\r\n{}\"".includes(text[i])) value += text[i++];
      tokens.push({ s: value });
    }
  }
  return tokens;
}

// Returns { root, bases: ["heroes/npc_dota_hero_x.txt", ...] }
function parse(input) {
  const tokens = tokenize(typeof input === "string" ? input : decode(input));
  const bases = [];
  let pos = 0;

  const block = () => {
    const object = {};
    while (pos < tokens.length && tokens[pos] !== "}") {
      const key = tokens[pos++];
      if (typeof key !== "object") {
        continue;
      }
      if (key.s === "#base" || key.s === "#include") {
        bases.push(tokens[pos++]?.s);
        continue;
      }
      const next = tokens[pos];
      let value;
      if (next === "{") {
        pos++;
        value = block();
        pos++;
      } else if (typeof next === "object") {
        value = next.s;
        pos++;
      } else {
        continue;
      }
      if (!(key.s in object)) {
        object[key.s] = value;
      }
    }
    return object;
  };

  return { root: block(), bases };
}

module.exports = { parse, decode };
