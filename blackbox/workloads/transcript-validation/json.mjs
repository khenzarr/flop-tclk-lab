// Bounded JSON parser preserving integer lexemes and rejecting duplicate members.
const NUMBER = Symbol('json-number-token');
export const numberLexeme = value => value?.[NUMBER] ?? null;

export function parseLosslessJson(source) {
  let at = 0;
  const fail = () => { throw new SyntaxError('INVALID_JSON_STRUCTURE'); };
  const space = () => { while (/[\t\n\r ]/.test(source[at] ?? '')) at += 1; };
  function string() {
    const start = at;
    if (source[at++] !== '"') fail();
    let escaped = false;
    while (at < source.length) {
      const ch = source[at++];
      if (!escaped && ch === '"') {
        let value; try { value = JSON.parse(source.slice(start, at)); } catch { fail(); }
        for (let i = 0; i < value.length; i += 1) {
          const unit = value.charCodeAt(i);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
          } else if (unit >= 0xdc00 && unit <= 0xdfff) fail();
        }
        return value;
      }
      if (!escaped && ch === '\\') escaped = true;
      else escaped = false;
    }
    fail();
  }
  function value(depth) {
    if (depth > 16) fail();
    space(); const ch = source[at];
    if (ch === '"') return string();
    if (ch === '{') {
      at += 1; space(); const out = Object.create(null);
      if (source[at] === '}') { at += 1; return out; }
      while (true) {
        space(); if (source[at] !== '"') fail(); const key = string(); space();
        if (source[at++] !== ':') fail();
        if (Object.hasOwn(out, key)) throw new SyntaxError('DUPLICATE_JSON_MEMBER');
        out[key] = value(depth + 1); space();
        if (source[at] === '}') { at += 1; return out; }
        if (source[at++] !== ',') fail();
      }
    }
    if (ch === '[') {
      at += 1; space(); const out = [];
      if (source[at] === ']') { at += 1; return out; }
      while (true) { out.push(value(depth + 1)); space(); if (source[at] === ']') { at += 1; return out; } if (source[at++] !== ',') fail(); }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, at)) { at += literal.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (match) { at += match[0].length; return Object.freeze({ [NUMBER]: match[0] }); }
    fail();
  }
  const parsed = value(0); space(); if (at !== source.length) fail(); return parsed;
}
