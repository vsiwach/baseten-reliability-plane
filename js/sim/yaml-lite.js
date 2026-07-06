/* yaml-lite.js — a tiny YAML subset parser, vendored so the site needs no
   build step and no CDN. Parses exactly the subset the four policy files
   use: nested maps, block lists of scalars or maps, inline [a, b] lists,
   scalars (number / bool / string), comments, and multi-line folded values
   indented under a key. Not a general YAML parser — tests pin it to the
   committed policy files. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.yaml = factory(); }
})(globalThis, function () {
  'use strict';

  function scalar(raw) {
    const s = raw.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~' || s === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      return inner ? inner.split(',').map(scalar) : [];
    }
    return s.replace(/^['"]|['"]$/g, '');
  }

  function stripComment(line) {
    // strip " # comment" outside quotes (policy files never quote hashes)
    const i = line.indexOf(' #');
    return i >= 0 ? line.slice(0, i) : line;
  }

  function parse(text) {
    const lines = text.split('\n')
      .map(stripComment)
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .map(l => ({ indent: l.match(/^ */)[0].length, body: l.trim() }));
    let pos = 0;

    function block(indent) {
      if (pos < lines.length && lines[pos].body.startsWith('- ') &&
          lines[pos].indent >= indent) return list(lines[pos].indent);
      return map(indent);
    }

    function map(indent) {
      const out = {};
      let lastKey = null;
      while (pos < lines.length) {
        const ln = lines[pos];
        if (ln.indent < indent || ln.body.startsWith('- ')) break;
        if (ln.indent > indent && lastKey !== null &&
            typeof out[lastKey] === 'string') {
          // folded continuation of the previous scalar value
          out[lastKey] += ' ' + ln.body; pos++; continue;
        }
        if (ln.indent !== indent) break;
        const m = ln.body.match(/^([^:]+):\s*(.*)$/);
        if (!m) break;
        pos++;
        const key = m[1].trim();
        if (m[2] === '') {
          const next = lines[pos];
          out[key] = (next && next.indent > indent) ? block(next.indent) : null;
        } else {
          out[key] = scalar(m[2]);
        }
        lastKey = key;
      }
      return out;
    }

    function list(indent) {
      const out = [];
      while (pos < lines.length) {
        const ln = lines[pos];
        if (ln.indent !== indent || !ln.body.startsWith('- ')) break;
        const rest = ln.body.slice(2);
        const m = rest.match(/^([^:[]+):\s*(.*)$/);
        if (m) {
          // list item that is a map: rewrite "- k: v" as "k: v" at indent+2
          lines[pos] = { indent: indent + 2, body: rest };
          out.push(map(indent + 2));
        } else {
          pos++; out.push(scalar(rest));
        }
      }
      return out;
    }

    return block(lines.length ? lines[0].indent : 0);
  }

  return { parse };
});
