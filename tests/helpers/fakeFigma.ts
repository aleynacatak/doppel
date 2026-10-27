// A small in-memory stand-in for the Figma Plugin API: enough of the node tree, text, fonts, images and export
// behavior for the action interpreter's tests. Geometry is simple: x/y are relative to the parent.

let nextId = 1;

export class FakeNode {
  id: string;
  name: string;
  type: string;
  parent: FakeNode | null = null;
  children: FakeNode[] = [];
  x = 0;
  y = 0;
  width = 100;
  private _height = 100;
  visible = true;
  removed = false;
  characters = "";
  fontName: { family: string; style: string } = { family: "Inter", style: "Regular" };
  fontSize = 12;
  hasMissingFont = false;
  textAutoResize = "NONE";
  textTruncation = "DISABLED";
  fills: unknown[] = [];
  layoutMode = "NONE";
  layoutPositioning = "AUTO";
  clipsContent = false;
  cornerRadius = 0;
  opacity = 1;
  paddingTop = 0;
  paddingRight = 0;
  paddingBottom = 0;
  paddingLeft = 0;
  itemSpacing = 0;
  rangeCalls: { method: string; start: number; end: number; value: unknown }[] = [];
  /** Pages: what the designer has selected. */
  selection: FakeNode[] = [];
  private pluginData: Record<string, string> = {};

  constructor(
    private readonly figma: FakeFigma,
    type: string,
    name: string,
    props: Partial<Pick<FakeNode, "x" | "y" | "width" | "characters" | "visible" | "layoutMode" | "clipsContent" | "textAutoResize">> & { height?: number } = {},
  ) {
    this.id = `${nextId}:${nextId++}`;
    this.type = type;
    this.name = name;
    const { height, ...rest } = props;
    Object.assign(this, rest);
    if (height !== undefined) this._height = height;
    figma.all.push(this);
  }

  /** Text with auto height grows with its content (10 px per character, 20 px per line). */
  get height() {
    if (this.type === "TEXT" && this.textAutoResize === "HEIGHT") {
      const perLine = Math.max(1, Math.floor(this.width / 10));
      return Math.max(1, Math.ceil(this.characters.length / perLine)) * 20;
    }
    return this._height;
  }

  set height(v: number) {
    this._height = v;
  }

  get absoluteBoundingBox() {
    let x = this.x;
    let y = this.y;
    for (let p = this.parent; p && p.type !== "PAGE"; p = p.parent) {
      x += p.x;
      y += p.y;
    }
    return { x, y, width: this.width, height: this.height };
  }

  private detach() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }

  appendChild(c: FakeNode) {
    c.detach();
    c.parent = this;
    this.children.push(c);
  }

  insertChild(i: number, c: FakeNode) {
    c.detach();
    c.parent = this;
    this.children.splice(i, 0, c);
  }

  remove() {
    this.detach();
    this.removed = true;
  }

  /** Like Figma: the copy lands on the current page until it is moved. */
  clone(): FakeNode {
    const copy = this.copyTree();
    this.figma.currentPage.appendChild(copy);
    return copy;
  }

  private copyTree(): FakeNode {
    const copy = new FakeNode(this.figma, this.type, this.name);
    for (const key of ["x", "y", "width", "visible", "characters", "fontSize", "hasMissingFont", "textAutoResize", "layoutMode", "clipsContent"] as const) {
      (copy as any)[key] = (this as any)[key];
    }
    copy.height = this._height;
    copy.fontName = { ...this.fontName };
    copy.fills = [...this.fills];
    for (const child of this.children) {
      const c = child.copyTree();
      c.parent = copy;
      copy.children.push(c);
    }
    return copy;
  }

  findOne(fn: (n: FakeNode) => boolean): FakeNode | null {
    for (const c of this.children) {
      if (fn(c)) return c;
      const deep = c.findOne(fn);
      if (deep) return deep;
    }
    return null;
  }

  findAll(fn: (n: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    for (const c of this.children) {
      if (fn(c)) out.push(c);
      out.push(...c.findAll(fn));
    }
    return out;
  }

  getPluginData(key: string) {
    return this.pluginData[key] ?? "";
  }

  setPluginData(key: string, value: string) {
    this.pluginData[key] = value;
  }

  getRangeAllFontNames() {
    return [this.fontName];
  }

  getRangeFontName() {
    return this.fontName;
  }

  setRangeFontName(start: number, end: number, value: unknown) {
    this.rangeCalls.push({ method: "fontName", start, end, value });
  }

  setRangeFontSize(start: number, end: number, value: unknown) {
    this.rangeCalls.push({ method: "fontSize", start, end, value });
  }

  setRangeFills(start: number, end: number, value: unknown) {
    this.rangeCalls.push({ method: "fills", start, end, value });
  }

  setRangeTextDecoration(start: number, end: number, value: unknown) {
    this.rangeCalls.push({ method: "textDecoration", start, end, value });
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }

  rescale(s: number) {
    this.width *= s;
    this.height *= s;
  }

  async exportAsync() {
    return new Uint8Array([1, 2, 3]);
  }

  async loadAsync() {}
}

export class FakeFigma {
  all: FakeNode[] = [];
  mixed = Symbol("mixed");
  /** Font families + styles that aren't installed ("Family/Style"). */
  missingFonts = new Set<string>();
  loadedFonts: string[] = [];
  root: { children: FakeNode[] };
  currentPage: FakeNode;

  constructor() {
    this.currentPage = new FakeNode(this, "PAGE", "Page 1");
    this.root = { children: [this.currentPage] };
  }

  node(type: string, name: string, parent: FakeNode, props: ConstructorParameters<typeof FakeNode>[3] = {}) {
    const n = new FakeNode(this, type, name, props);
    parent.appendChild(n);
    return n;
  }

  async getNodeByIdAsync(id: string) {
    return this.all.find((n) => n.id === id && !n.removed) ?? null;
  }

  async loadFontAsync(font: { family: string; style: string }) {
    const id = `${font.family}/${font.style}`;
    if (this.missingFonts.has(id)) throw new Error(`Font ${id} isn't available`);
    this.loadedFonts.push(id);
  }

  createImage(bytes: Uint8Array) {
    if (bytes.length === 0) throw new Error("Image is too small");
    return { hash: "hash-1", getSizeAsync: async () => ({ width: 200, height: 200 }) };
  }

  getImageByHash() {
    return { getSizeAsync: async () => ({ width: 200, height: 200 }) };
  }

  base64Decode(s: string) {
    return new Uint8Array(Buffer.from(s, "base64"));
  }

  base64Encode(u: Uint8Array) {
    return Buffer.from(u).toString("base64");
  }

  createNodeFromSvg(svg: string) {
    if (!svg.includes("<svg")) throw new Error("Invalid SVG");
    const n = new FakeNode(this, "FRAME", "svg", { width: 50, height: 20 });
    this.currentPage.appendChild(n);
    return n;
  }

  createPage() {
    const p = new FakeNode(this, "PAGE", "Page");
    this.root.children.push(p);
    return p;
  }
}
