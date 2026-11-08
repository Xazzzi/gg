// Locates and names a creation site from the script that the page loaded, through its source map when it has one.
type SourceMap = {
  mappings: string;
  sources: string[];
  sourceRoot?: string;
  sourcesContent?: (string | null)[];
};

const ID = String.raw`[\p{ID_Start}$_#][\p{ID_Continue}$‌‍]*`;
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
const PATH = `(?:${ID}${GAP}\\.${GAP})*`;
// V8 points at `new`, at the callee, or at the call parens of `(0, ns.f)()`.
const tail = new RegExp(
  `(?:(${ID})${GAP}=|[{,]${GAP}(${ID}|"[^"\\n]*"|'[^'\\n]*')${GAP}:|(?<![\\w$])(return)\\b|(=>))${GAP}(?:await\\b${GAP})?(?:\\(${GAP}0${GAP},${GAP}${PATH}${ID}${GAP}\\)|${PATH})$`,
  "u",
);

// A factory, `return new Channel()` or `() => new Channel()`, takes the name of the frame's function.
export const bindingAt = (
  text: string,
  line: number,
  column: number,
  fn?: string,
) => {
  let at = 0;
  for (let n = 1; n < line; n++) if (!(at = text.indexOf("\n", at) + 1)) return;
  const end = at + column - 1;
  const m = tail.exec(text.slice(Math.max(0, end - 400), end));
  if (!m) return;
  if (m[3] || m[4]) return fn && `${fn}()`;
  return m[1] ?? m[2].replace(/^["']|["']$/g, "");
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (segment: string) => {
  const out: number[] = [];
  let value = 0,
    shift = 0;
  for (const c of segment) {
    const digit = B64.indexOf(c);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = shift = 0;
    }
  }
  return out;
};

// Maps a 1-based generated position to its original one, from the last segment at or before it.
export const locate = (map: SourceMap, line: number, column: number) => {
  const lines = map.mappings.split(";");
  let source = 0,
    from = 0,
    col = 0,
    found: { source: number; line: number; column: number } | undefined;
  for (let l = 0; l < line && l < lines.length; l++) {
    let gen = 0;
    for (const segment of lines[l].split(",")) {
      if (!segment) continue;
      const [g, s, ol, oc] = vlq(segment);
      gen += g;
      if (s === undefined) continue;
      source += s;
      from += ol;
      col += oc;
      if (l === line - 1 && gen <= column - 1)
        found = { source, line: from + 1, column: col + 1 };
    }
  }
  return found;
};

// A same-origin original shows as its path, as the hook shows a generated site.
const short = (url: string, from: string) => {
  try {
    const at = new URL(url);
    return at.origin === new URL(from).origin ? at.pathname : url;
  } catch {
    return url;
  }
};

export type Origin = {
  url: string;
  line: number;
  column: number;
  name?: string;
  label?: string; // The original site, only when a source map leads to it
};

// Resolves a stack line to its original position and the binding there.
export const originAt = async (
  frame: string,
  load: (url: string) => Promise<string | undefined>,
): Promise<Origin | undefined> => {
  const m =
    /at (?:(?:async )?(?:new )?([^\s(]+) \()?(.+?):(\d+):(\d+)\)?$/.exec(frame);
  if (!m) return;
  const fn = m[1]?.split(".").pop()?.replace(/^<.*/, "");
  let [url, line, column] = [m[2], Number(m[3]), Number(m[4])],
    place: Omit<Origin, "name"> | undefined;
  let text = await load(url);
  const ref = text && /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(text)?.[1];
  if (ref)
    try {
      const mapUrl = new URL(ref, url).href;
      const map: SourceMap = JSON.parse((await load(mapUrl)) ?? "");
      const at = locate(map, line, column);
      if (at) {
        const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, "/") : "";
        const source = new URL(map.sources[at.source], new URL(root, mapUrl))
          .href;
        const original =
          map.sourcesContent?.[at.source] ?? (await load(source));
        place = {
          url: source,
          line: at.line,
          column: at.column,
          label: `${short(source, url)}:${at.line}:${at.column}`,
        };
        if (original) [text, line, column] = [original, at.line, at.column];
      }
    } catch {}
  return {
    url,
    line,
    column,
    ...place,
    name: text && bindingAt(text, line, column, fn),
  };
};
