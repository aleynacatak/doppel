// Minimal JSON polyfill for ExtendScript (ES3 has no JSON object).
// Based on the approach of Douglas Crockford's json2.js (public domain): stringify walks values,
// parse validates the text with regular expressions before evaluating it.
export const JSON2 = String.raw`
if (typeof JSON !== "object") { JSON = {}; }
(function () {
  var rx_escapable = /[\\"\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
  var meta = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", "\"": "\\\"", "\\": "\\\\" };
  function quote(string) {
    rx_escapable.lastIndex = 0;
    return rx_escapable.test(string)
      ? "\"" + string.replace(rx_escapable, function (a) {
          var c = meta[a];
          return typeof c === "string" ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
        }) + "\""
      : "\"" + string + "\"";
  }
  function str(key, holder) {
    var i, k, v, partial, value = holder[key];
    if (value && typeof value === "object" && typeof value.toJSON === "function") { value = value.toJSON(key); }
    switch (typeof value) {
      case "string": return quote(value);
      case "number": return isFinite(value) ? String(value) : "null";
      case "boolean": return String(value);
      case "object":
        if (!value) { return "null"; }
        partial = [];
        if (Object.prototype.toString.apply(value) === "[object Array]") {
          for (i = 0; i < value.length; i += 1) { partial[i] = str(i, value) || "null"; }
          return "[" + partial.join(",") + "]";
        }
        for (k in value) {
          if (Object.prototype.hasOwnProperty.call(value, k)) {
            v = str(k, value);
            if (v) { partial.push(quote(k) + ":" + v); }
          }
        }
        return "{" + partial.join(",") + "}";
    }
    return undefined;
  }
  if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (value) { return str("", { "": value }); };
  }
  if (typeof JSON.parse !== "function") {
    var rx_dangerous = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
    JSON.parse = function (text) {
      text = String(text);
      rx_dangerous.lastIndex = 0;
      if (rx_dangerous.test(text)) {
        text = text.replace(rx_dangerous, function (a) { return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4); });
      }
      if (/^[\],:{}\s]*$/.test(
        text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
          .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
          .replace(/(?:^|:|,)(?:\s*\[)+/g, "")
      )) {
        return eval("(" + text + ")");
      }
      throw new SyntaxError("JSON.parse: invalid JSON");
    };
  }
}());
`;
