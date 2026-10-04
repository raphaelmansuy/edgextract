import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export interface GNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  color: string;
  /** Not a kept name: the model was unsure, so a person decides. */
  pending: boolean;
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
  evidence: string;
  /** Dashed ghost edge for a link waiting on a person. */
  pending: boolean;
}

type Link = SimulationLinkDatum<GNode> & { edge: GEdge };

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_R = 22;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function humanize(rel: string): string {
  return rel.toLowerCase().replace(/_/g, " ");
}

function initials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : label.slice(0, 2)).toUpperCase();
}

export interface GraphHandlers {
  onHover: (edge: GEdge | null) => void;
  onSelect: (edge: GEdge | null) => void;
}

/** A small SVG force graph. Positions survive re-runs, so moving a cutoff feels continuous. */
export class GraphView {
  private root: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private sim: Simulation<GNode, Link> | null = null;
  private nodes: GNode[] = [];
  private links: Link[] = [];
  private known = new Map<string, { x: number; y: number }>();
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, { g: SVGGElement; path: SVGPathElement; label: SVGGElement }>();
  private curve = new Map<string, number>();
  private selected: string | null = null;
  private fitted = { tx: 0, ty: 0, k: 1 };

  constructor(
    private svg: SVGSVGElement,
    private handlers: GraphHandlers,
  ) {
    const defs = el("defs", {}, svg);
    for (const [id, color] of [
      ["arrow", "#94a3b8"],
      ["arrow-hot", "#e2e8f0"],
      ["arrow-pending", "#fbbf24"],
    ] as const) {
      const m = el(
        "marker",
        { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
        defs,
      );
      el("path", { d: "M0 0L10 5L0 10z", fill: color }, m);
    }
    this.root = el("g", { class: "world" }, svg);
    this.edgeLayer = el("g", { class: "edges" }, this.root);
    this.nodeLayer = el("g", { class: "nodes" }, this.root);
    svg.addEventListener("click", (ev) => {
      if (ev.target === svg) this.select(null);
    });
  }

  update(nodes: GNode[], edges: GEdge[]): void {
    for (const n of this.nodes) {
      if (n.x != null && n.y != null) this.known.set(n.id, { x: n.x, y: n.y });
    }
    this.sim?.stop();
    this.nodes = nodes.map((n) => {
      const prev = this.known.get(n.id);
      return prev ? { ...n, x: prev.x, y: prev.y } : { ...n };
    });
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((edge) => ({ source: edge.source, target: edge.target, edge }));

    // Spread parallel edges between the same two names apart.
    this.curve.clear();
    const groups = new Map<string, Link[]>();
    for (const l of this.links) {
      const key = [l.edge.source, l.edge.target].sort().join("||");
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    for (const group of groups.values()) {
      group.forEach((l, i) => {
        const flip = l.edge.source > l.edge.target ? -1 : 1;
        this.curve.set(l.edge.id, (i - (group.length - 1) / 2) * 46 * flip);
      });
    }

    const { width, height } = this.size();
    this.sim = forceSimulation<GNode>(this.nodes)
      .force(
        "link",
        forceLink<GNode, Link>(this.links)
          .id((d) => d.id)
          .distance(190)
          .strength(0.5),
      )
      .force("charge", forceManyBody<GNode>().strength(-900))
      .force("collide", forceCollide<GNode>(70))
      .force("center", forceCenter(0, 0))
      .force("x", forceX<GNode>(0).strength(0.07))
      .force("y", forceY<GNode>(0).strength(0.1 * (width / Math.max(height, 1))))
      .stop();

    // Settle before the first paint so screenshots and tests see a calm graph.
    for (let i = 0; i < 320; i++) this.sim.tick();
    this.render();
    this.fit();
    // Stay still until someone drags a name; dragging restarts the simulation.
    this.sim.on("tick", () => this.positions());
  }

  private size(): { width: number; height: number } {
    const r = this.svg.getBoundingClientRect();
    return { width: r.width || 800, height: r.height || 500 };
  }

  private fit(): void {
    const { width, height } = this.size();
    if (!this.nodes.length) {
      this.fitted = { tx: width / 2, ty: height / 2, k: 1 };
    } else {
      const pad = 90;
      const xs = this.nodes.map((n) => n.x ?? 0);
      const ys = this.nodes.map((n) => n.y ?? 0);
      const minX = Math.min(...xs) - pad;
      const maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad;
      const maxY = Math.max(...ys) + pad;
      const k = Math.min(1.25, width / (maxX - minX), height / (maxY - minY));
      this.fitted = {
        k,
        tx: width / 2 - ((minX + maxX) / 2) * k,
        ty: height / 2 - ((minY + maxY) / 2) * k,
      };
    }
    this.root.setAttribute("transform", `translate(${this.fitted.tx} ${this.fitted.ty}) scale(${this.fitted.k})`);
  }

  private select(id: string | null): void {
    this.selected = id;
    for (const [eid, parts] of this.edgeEls) parts.g.classList.toggle("selected", eid === id);
    const link = this.links.find((l) => l.edge.id === id);
    this.handlers.onSelect(link ? link.edge : null);
  }

  private render(): void {
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.edgeEls.clear();
    this.nodeEls.clear();

    for (const l of this.links) {
      const e = l.edge;
      const g = el(
        "g",
        {
          class: `edge${e.pending ? " pending" : ""}`,
          "data-testid": "edge",
          "data-source": e.source,
          "data-target": e.target,
          "data-relation": e.relation,
          "data-weight": e.weight.toFixed(2),
          "data-pending": String(e.pending),
        },
        this.edgeLayer,
      );
      const path = el(
        "path",
        { class: "edge-line", "marker-end": e.pending ? "url(#arrow-pending)" : "url(#arrow)" },
        g,
      );
      // A fat invisible stroke makes thin edges easy to hover.
      const hit = el("path", { class: "edge-hit" }, g);
      hit.dataset.for = e.id;
      const label = el("g", { class: "edge-label" }, g);
      const text = `${humanize(e.relation)}${e.pending ? " ?" : ""}`;
      const w = text.length * 6.4 + 38;
      el("rect", { x: -w / 2, y: -11, width: w, height: 22, rx: 11 }, label);
      const t = el("text", { x: -w / 2 + 10, y: 4 }, label);
      t.textContent = text;
      const wt = el("text", { class: "weight", x: w / 2 - 10, y: 4, "text-anchor": "end" }, label);
      wt.textContent = e.weight.toFixed(2);
      g.addEventListener("pointerenter", () => {
        g.classList.add("hot");
        path.setAttribute("marker-end", "url(#arrow-hot)");
        this.handlers.onHover(e);
      });
      g.addEventListener("pointerleave", () => {
        g.classList.remove("hot");
        path.setAttribute("marker-end", e.pending ? "url(#arrow-pending)" : "url(#arrow)");
        this.handlers.onHover(null);
      });
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.select(this.selected === e.id ? null : e.id);
      });
      this.edgeEls.set(e.id, { g, path, label });
    }

    for (const n of this.nodes) {
      const g = el(
        "g",
        {
          class: `node${n.pending ? " pending" : ""}`,
          "data-testid": "node",
          "data-name": n.id,
          "data-type": n.type,
          "data-pending": String(n.pending),
          tabindex: 0,
        },
        this.nodeLayer,
      );
      el(
        "circle",
        {
          r: NODE_R,
          fill: `${n.color}33`,
          stroke: n.color,
          "stroke-width": 2.5,
          "stroke-dasharray": n.pending ? "5 4" : "none",
        },
        g,
      );
      const ini = el("text", { class: "ini", y: 4, "text-anchor": "middle", fill: n.color }, g);
      ini.textContent = n.pending ? "?" : initials(n.label);
      const name = el("text", { class: "name", y: NODE_R + 18, "text-anchor": "middle" }, g);
      name.textContent = n.label;
      const kind = el("text", { class: "kind", y: NODE_R + 32, "text-anchor": "middle" }, g);
      kind.textContent = n.type.toLowerCase().replace(/_/g, " ");
      this.drag(g, n);
      this.nodeEls.set(n.id, g);
    }
    this.positions();
  }

  private positions(): void {
    for (const n of this.nodes) {
      this.nodeEls.get(n.id)?.setAttribute("transform", `translate(${n.x ?? 0} ${n.y ?? 0})`);
    }
    for (const l of this.links) {
      const parts = this.edgeEls.get(l.edge.id);
      const s = l.source as GNode;
      const t = l.target as GNode;
      if (!parts || typeof s !== "object" || typeof t !== "object") continue;
      const x1 = s.x ?? 0;
      const y1 = s.y ?? 0;
      const x2 = t.x ?? 0;
      const y2 = t.y ?? 0;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const off = this.curve.get(l.edge.id) ?? 0;
      const cx = (x1 + x2) / 2 + (-dy / len) * off * 2;
      const cy = (y1 + y2) / 2 + (dx / len) * off * 2;
      // Start and stop at the circle edge so the arrowhead is visible.
      const trim = (px: number, py: number, qx: number, qy: number, r: number): [number, number] => {
        const d = Math.hypot(qx - px, qy - py) || 1;
        return [px + ((qx - px) / d) * r, py + ((qy - py) / d) * r];
      };
      const [sx, sy] = trim(x1, y1, cx, cy, NODE_R + 2);
      const [ex, ey] = trim(x2, y2, cx, cy, NODE_R + 5);
      const d = `M${sx} ${sy} Q${cx} ${cy} ${ex} ${ey}`;
      parts.path.setAttribute("d", d);
      (parts.g.querySelector(".edge-hit") as SVGPathElement).setAttribute("d", d);
      const mx = 0.25 * sx + 0.5 * cx + 0.25 * ex;
      const my = 0.25 * sy + 0.5 * cy + 0.25 * ey;
      parts.label.setAttribute("transform", `translate(${mx} ${my})`);
    }
  }

  private drag(g: SVGGElement, n: GNode): void {
    g.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      g.setPointerCapture(ev.pointerId);
      const k = this.fitted.k;
      const start = { x: ev.clientX, y: ev.clientY, nx: n.x ?? 0, ny: n.y ?? 0 };
      this.sim?.alphaTarget(0.25).restart();
      const move = (e: PointerEvent) => {
        n.fx = start.nx + (e.clientX - start.x) / k;
        n.fy = start.ny + (e.clientY - start.y) / k;
      };
      const up = () => {
        n.fx = null;
        n.fy = null;
        this.sim?.alphaTarget(0);
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
  }

  refit(): void {
    this.fit();
  }
}
