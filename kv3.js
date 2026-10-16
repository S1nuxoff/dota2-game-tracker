// KeyValues3 in its text form, as Source2Viewer writes it (particles, vdata): to plain JSON.
// { key = value } objects, [ a, b, ] arrays, "strings", numbers, true/false/null, and values
// with a prefix (resource:"...", soundevent:"...") kept as their string.

function parse(text) {
  let at = 0;
  const length = text.length;

  const skip = () => {
    while (at < length) {
      const char = text[at];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === ",") {
        at++;
      } else if (char === "/" && text[at + 1] === "/") {
        while (at < length && text[at] !== "\n") at++;
      } else if (char === "/" && text[at + 1] === "*") {
        at = text.indexOf("*/", at + 2) + 2;
      } else if (char === "<" && text.startsWith("<!--", at)) {
        at = text.indexOf("-->", at) + 3;
      } else {
        break;
      }
    }
  };

  const string = () => {
    // Multi-line strings come in triple quotes
    if (text.startsWith('"""', at)) {
      const end = text.indexOf('"""', at + 3);
      const value = text.slice(at + 3, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      at = end + 3;
      return value;
    }
    at++;
    let value = "";
    while (at < length && text[at] !== '"') {
      if (text[at] === "\\") {
        const next = text[at + 1];
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
        at += 2;
      } else {
        value += text[at++];
      }
    }
    at++;
    return value;
  };

  const bare = () => {
    const start = at;
    while (at < length && !/[\s,=\]\}\[\{"]/.test(text[at])) at++;
    return text.slice(start, at);
  };

  const value = () => {
    skip();
    const char = text[at];
    if (char === "{") {
      at++;
      const object = {};
      for (;;) {
        skip();
        if (text[at] === "}") {
          at++;
          return object;
        }
        const key = text[at] === '"' ? string() : bare();
        skip();
        if (text[at] === "=") at++;
        object[key] = value();
      }
    }
    if (char === "[") {
      at++;
      const array = [];
      for (;;) {
        skip();
        if (text[at] === "]") {
          at++;
          return array;
        }
        array.push(value());
      }
    }
    if (char === '"') {
      return string();
    }
    const word = bare();
    // A prefixed value: resource:"...", resource_name:"...", soundevent:"...", panorama:"..."
    if (text[at] === '"' && word.endsWith(":")) {
      return string();
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    const number = Number(word);
    return word !== "" && !Number.isNaN(number) ? number : word;
  };

  return value();
}

module.exports = { parse };
