/**
 * Streaming Apple plist parser (§2).
 *
 * Hand-rolled against the subset iTunes/Music.app actually emits:
 * <dict>, <array>, <key>, <string>, <integer>, <real>, <date>, <data>,
 * <true/>, <false/>. Feed text chunks with `write()`; complete elements are
 * consumed, partial trailing input is carried to the next chunk, so the whole
 * document is never held in memory and no DOMParser is involved.
 *
 * Container values under hooked paths are emitted via callbacks and NOT
 * retained, which is what keeps memory flat on large libraries.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | PlistValue[]
  | { [k: string]: PlistValue };

type Frame = {
  type: "dict" | "array";
  key?: string; // key under which this frame sits in its parent dict
  pendingKey?: string; // last <key> seen inside this dict
  obj: PlistValue[] | { [k: string]: PlistValue };
  /** streaming frames don't accumulate children */
  streaming: boolean;
};

export type PlistHooks = {
  /** Called for each value dict inside the top-level "Tracks" dict. */
  onTrack?: (trackKey: string, value: Record<string, PlistValue>) => void;
  /** Called for each dict inside the top-level "Playlists" array. */
  onPlaylist?: (value: Record<string, PlistValue>) => void;
};

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[body] ?? m;
  });
}

export class StreamingPlistParser {
  private buf = "";
  private stack: Frame[] = [];
  private root: PlistValue | undefined;
  private hooks: PlistHooks;
  /** path helper flags for the two streamed sections */
  private inTracksDict: Frame | null = null;
  private inPlaylistsArray: Frame | null = null;

  constructor(hooks: PlistHooks = {}) {
    this.hooks = hooks;
  }

  get result(): PlistValue | undefined {
    return this.root;
  }

  write(chunk: string): void {
    this.buf += chunk;
    this.consume();
  }

  end(): void {
    this.consume();
    // Trailing whitespace/junk after </plist> is fine; anything structural
    // left over means a truncated file.
    if (this.stack.length > 0) {
      throw new Error("plist: unexpected end of input (unclosed containers)");
    }
  }

  private consume(): void {
    const buf = this.buf;
    let pos = 0;
    const n = buf.length;

    while (pos < n) {
      const lt = buf.indexOf("<", pos);
      if (lt === -1) {
        pos = n;
        break;
      }
      const gt = buf.indexOf(">", lt);
      if (gt === -1) {
        pos = lt; // incomplete tag, carry over
        break;
      }
      const tag = buf.slice(lt + 1, gt);

      // Skip prolog / doctype / plist envelope / comments
      if (
        tag[0] === "?" ||
        tag[0] === "!" ||
        tag.startsWith("plist") ||
        tag === "/plist"
      ) {
        // <!-- comments --> need their real terminator
        if (tag.startsWith("!--") && !tag.endsWith("--")) {
          const end = buf.indexOf("-->", lt);
          if (end === -1) {
            pos = lt;
            break;
          }
          pos = end + 3;
          continue;
        }
        pos = gt + 1;
        continue;
      }

      if (tag === "dict" || tag === "array") {
        this.open(tag);
        pos = gt + 1;
        continue;
      }
      if (tag === "/dict" || tag === "/array") {
        this.close();
        pos = gt + 1;
        continue;
      }
      if (tag === "dict/" || tag === "array/") {
        this.open(tag === "dict/" ? "dict" : "array");
        this.close();
        pos = gt + 1;
        continue;
      }
      if (tag === "true/" || tag === "false/") {
        this.value(tag === "true/");
        pos = gt + 1;
        continue;
      }

      // Scalar elements with text content
      const scalar = tag.match(/^(key|string|integer|real|date|data)(\/?)$/);
      if (scalar) {
        const name = scalar[1];
        if (scalar[2] === "/") {
          this.scalar(name, "");
          pos = gt + 1;
          continue;
        }
        const closeTag = `</${name}>`;
        const closeAt = buf.indexOf(closeTag, gt + 1);
        if (closeAt === -1) {
          pos = lt; // content incomplete, carry over
          break;
        }
        this.scalar(name, buf.slice(gt + 1, closeAt));
        pos = closeAt + closeTag.length;
        continue;
      }

      throw new Error(`plist: unexpected tag <${tag.slice(0, 40)}>`);
    }

    this.buf = pos < n ? buf.slice(pos) : "";
  }

  private open(type: "dict" | "array"): void {
    const parent = this.stack[this.stack.length - 1];
    const key = parent?.type === "dict" ? parent.pendingKey : undefined;
    if (parent?.type === "dict") parent.pendingKey = undefined;

    const frame: Frame = {
      type,
      key,
      obj: type === "dict" ? {} : [],
      streaming: false,
    };

    // Mark the streamed sections. Their direct children get emitted via
    // hooks instead of accumulating.
    const isRootChild = this.stack.length === 1;
    if (isRootChild && type === "dict" && key === "Tracks" && this.hooks.onTrack) {
      frame.streaming = true;
      this.inTracksDict = frame;
    }
    if (
      isRootChild &&
      type === "array" &&
      key === "Playlists" &&
      this.hooks.onPlaylist
    ) {
      frame.streaming = true;
      this.inPlaylistsArray = frame;
    }

    this.stack.push(frame);
  }

  private close(): void {
    const frame = this.stack.pop();
    if (!frame) throw new Error("plist: unbalanced close tag");
    if (frame === this.inTracksDict) this.inTracksDict = null;
    if (frame === this.inPlaylistsArray) this.inPlaylistsArray = null;
    this.attach(frame.obj, frame.key, frame);
  }

  private scalar(name: string, raw: string): void {
    const top = this.stack[this.stack.length - 1];
    if (name === "key") {
      if (!top || top.type !== "dict")
        throw new Error("plist: <key> outside dict");
      top.pendingKey = decodeEntities(raw);
      return;
    }
    let v: PlistValue;
    switch (name) {
      case "string":
        v = decodeEntities(raw);
        break;
      case "integer":
        v = parseInt(raw, 10);
        break;
      case "real":
        v = parseFloat(raw);
        break;
      case "date":
        v = new Date(raw.trim());
        break;
      case "data":
        v = raw.replace(/\s+/g, ""); // keep base64 as string
        break;
      default:
        throw new Error(`plist: unknown scalar <${name}>`);
    }
    this.value(v);
  }

  private value(v: PlistValue): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.root = v;
      return;
    }
    if (top.type === "dict") {
      const k = top.pendingKey;
      if (k === undefined) throw new Error("plist: value without <key> in dict");
      top.pendingKey = undefined;
      this.attachToDict(top, k, v);
    } else {
      this.attachToArray(top, v);
    }
  }

  /** Attach a finished container `obj` (that lived under `key`) to the new top. */
  private attach(obj: PlistValue, key: string | undefined, closed: Frame): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.root = obj;
      return;
    }
    // Emit streamed children instead of accumulating them.
    if (top === this.inTracksDict && this.hooks.onTrack) {
      if (key !== undefined && closed.type === "dict") {
        this.hooks.onTrack(key, closed.obj as Record<string, PlistValue>);
      }
      return;
    }
    if (top === this.inPlaylistsArray && this.hooks.onPlaylist) {
      if (closed.type === "dict") {
        this.hooks.onPlaylist(closed.obj as Record<string, PlistValue>);
      }
      return;
    }
    if (top.type === "dict") {
      if (key === undefined)
        throw new Error("plist: container without <key> in dict");
      this.attachToDict(top, key, obj);
    } else {
      this.attachToArray(top, obj);
    }
  }

  private attachToDict(frame: Frame, key: string, v: PlistValue): void {
    if (frame.streaming) return; // scalars directly under a streamed frame: drop
    (frame.obj as Record<string, PlistValue>)[key] = v;
  }

  private attachToArray(frame: Frame, v: PlistValue): void {
    if (frame.streaming) return;
    (frame.obj as PlistValue[]).push(v);
  }
}
