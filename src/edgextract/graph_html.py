"""Interactive knowledge-graph HTML. No CDN, no network."""

from __future__ import annotations

import html
import json
from pathlib import Path

from edgextract.ontology import Ontology
from edgextract.report import _link_sentence, _pretty_name, _pretty_type, _review_sentence
from edgextract.types import ExtractionResult

CSS = """
:root { --bg:#0f1419; --card:#161d26; --ink:#f4f1ea; --muted:#9aa8b5; --soft:#6b7a88; --line:#2a3542; --accent:#e8a87c; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.55 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; background:var(--bg); color:var(--ink); }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 80px; }
h1 { font-size: 1.9rem; font-weight:650; letter-spacing:-0.01em; margin: 0 0 8px; }
h2 { font-size: 1.15rem; margin: 28px 0 8px; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin: 12px 0; }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin: 8px 0 10px; }
input[type=search] { background:#0b1017; color:var(--ink); border:1px solid var(--line); border-radius:10px; padding:7px 12px; min-width:200px; font:inherit; font-size:14px; }
input[type=search]:focus, button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
button { background:#1d2733; color:var(--ink); border:1px solid var(--line); border-radius:10px; padding:6px 12px; cursor:pointer; font:inherit; font-size:14px; }
button:hover { background:#27344a; }
.legend { display:flex; flex-wrap:wrap; gap:8px; }
.legend button { display:flex; align-items:center; gap:7px; }
.dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
.chip { font-size:13px; color:var(--muted); }
.stage { position:relative; width:100%; height:560px; background:#0b1017; border:1px solid var(--line); border-radius:14px; overflow:hidden; touch-action:none; }
.stage svg { width:100%; height:100%; display:block; cursor:grab; }
.key { position:absolute; left:14px; bottom:12px; display:flex; gap:16px; font-size:12px; color:var(--muted); background:rgba(11,16,23,.82); padding:6px 10px; border-radius:8px; }
.key i { display:inline-block; width:22px; border-top:2px solid #64748b; vertical-align:middle; margin-right:6px; }
.key i.dash { border-top:2px dashed #e5b567; }
.detail { min-height: 3.2em; margin: 12px 2px 0; font-size:15px; }
@media print {
  .toolbar, button, .key { display:none !important; }
  .stage { height: 440px; break-inside: avoid; }
}
"""

SVG_CSS = """
.edge { stroke:#64748b; stroke-width:1.6; fill:none; }
.edge.review { stroke-dasharray:6 5; stroke:#e5b567; }
.edge.on { stroke:#f4f1ea; stroke-width:2.4; }
.edge.dim, .elabel.dim { opacity:0.10; }
.hit { stroke:transparent; stroke-width:14; fill:none; cursor:pointer; }
.elabel { fill:#9aa8b5; font:11px -apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif; text-anchor:middle; paint-order:stroke; stroke:#0b1017; stroke-width:4px; stroke-linejoin:round; pointer-events:none; }
.elabel.review { fill:#e5b567; }
.node circle { stroke:#0b1017; stroke-width:2.5; cursor:grab; }
.node.sel circle { stroke:#f4f1ea; }
.node text { fill:#f4f1ea; font:600 12.5px -apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif; paint-order:stroke; stroke:#0b1017; stroke-width:4px; stroke-linejoin:round; pointer-events:none; }
.node.dim { opacity:0.18; }
"""

JS = r"""
(function(){
  const NS = "http://www.w3.org/2000/svg";
  const data = window.EDGEXTRACT_GRAPH;
  const svg = document.getElementById("g");
  const world = document.getElementById("world");
  const bg = document.getElementById("bg");
  const layers = {edges: document.getElementById("edges"), labels: document.getElementById("labels"), nodes: document.getElementById("nodes")};
  const detail = document.getElementById("detail");
  const search = document.getElementById("search");
  const W = 1000, H = 560;
  const DEFAULT = "Click a name to see its links. Hover a line to read the sentence behind it.";

  const nodes = data.nodes.map((n,i)=>{
    const a = 2*Math.PI*i/Math.max(1,data.nodes.length);
    return {...n, x:W/2+200*Math.cos(a), y:H/2+160*Math.sin(a), vx:0, vy:0, pin:false, deg:0};
  });
  const byId = Object.fromEntries(nodes.map(n=>[n.id,n]));
  const edges = data.edges.filter(e=>byId[e.source] && byId[e.target] && e.source!==e.target).map(e=>({...e}));
  edges.forEach(e=>{ byId[e.source].deg++; byId[e.target].deg++; });
  nodes.forEach(n=>{ n.r = 11 + Math.min(9, n.deg*2); });

  // Give parallel edges between the same two names their own curve.
  const groups = {};
  edges.forEach(e=>{ const k=[e.source,e.target].sort().join("||"); (groups[k]=groups[k]||[]).push(e); });
  Object.values(groups).forEach(g=>g.forEach((e,i)=>{
    const off = i-(g.length-1)/2;
    e.bend = off*58 * (e.source > e.target ? -1 : 1);
    const tc = 0.5 + off*0.26;
    e.lt = e.source < e.target ? tc : 1-tc;
  }));

  const hiddenTypes = new Set(), hiddenRels = new Set();
  let selected = null, hovered = null;
  let view = {x:0,y:0,k:1};
  const showAllLabels = edges.length <= 28;

  // Persistent DOM
  edges.forEach(e=>{
    e.path = document.createElementNS(NS,"path");
    e.path.setAttribute("class","edge"+(e.review?" review":""));
    e.hit = document.createElementNS(NS,"path");
    e.hit.setAttribute("class","hit");
    e.lab = document.createElementNS(NS,"text");
    e.lab.setAttribute("class","elabel"+(e.review?" review":""));
    e.lab.textContent = e.label + (e.review?" ?":"");
    e.hit.addEventListener("mouseenter",()=>{ hovered=e; paint(); setDetail(e.sentence+(e.evidence?" \u201c"+e.evidence+"\u201d":"")); });
    e.hit.addEventListener("mouseleave",()=>{ hovered=null; paint(); setDetail(selected?selDetail():DEFAULT); });
    layers.edges.appendChild(e.path); layers.edges.appendChild(e.hit); layers.labels.appendChild(e.lab);
  });
  nodes.forEach(n=>{
    n.g = document.createElementNS(NS,"g"); n.g.setAttribute("class","node");
    n.c = document.createElementNS(NS,"circle"); n.c.setAttribute("r",n.r); n.c.setAttribute("fill",n.color||"#94a3b8");
    n.t = document.createElementNS(NS,"text"); n.t.textContent = n.label;
    n.g.appendChild(n.c); n.g.appendChild(n.t); layers.nodes.appendChild(n.g);
    n.c.addEventListener("pointerdown", ev=>startDrag(ev,n));
    n.c.addEventListener("mouseenter",()=>{ if(!selected) setDetail(n.label+" is a "+n.kind.toLowerCase()+"."); });
    n.c.addEventListener("mouseleave",()=>{ if(!selected) setDetail(DEFAULT); });
  });

  function nodeVisible(n){ return !hiddenTypes.has(n.type); }
  function edgeVisible(e){
    const a=byId[e.source], b=byId[e.target];
    if(!nodeVisible(a)||!nodeVisible(b)||hiddenRels.has(e.type)) return false;
    const q=(search.value||"").trim().toLowerCase();
    return !q || a.label.toLowerCase().includes(q) || b.label.toLowerCase().includes(q) || e.label.toLowerCase().includes(q);
  }
  function setDetail(t){ detail.textContent = t; }
  function selDetail(){
    const n = byId[selected];
    const own = edges.filter(e=>e.source===selected||e.target===selected).map(e=>e.sentence);
    return own.length ? own.join(" ") : n.label+" has no kept links.";
  }

  function geometry(e){
    const a=byId[e.source], b=byId[e.target];
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    let dx=b.x-a.x, dy=b.y-a.y; const d=Math.hypot(dx,dy)||1;
    const cx=mx+(-dy/d)*e.bend, cy=my+(dx/d)*e.bend;
    const u=(px,py,qx,qy)=>{ const l=Math.hypot(qx-px,qy-py)||1; return [(qx-px)/l,(qy-py)/l]; };
    const [sx,sy]=u(a.x,a.y,cx,cy), [ex,ey]=u(cx,cy,b.x,b.y);
    const x1=a.x+sx*(a.r+2), y1=a.y+sy*(a.r+2);
    const x2=b.x-ex*(b.r+6), y2=b.y-ey*(b.r+6);
    const t = e.lt===undefined ? 0.5 : e.lt;
    return {x1,y1,x2,y2,cx,cy,lx:(1-t)*(1-t)*x1+2*(1-t)*t*cx+t*t*x2, ly:(1-t)*(1-t)*y1+2*(1-t)*t*cy+t*t*y2};
  }

  // Slide each label along its own edge to a spot that no other line, name, or label crosses.
  function bez(g,t){ const u=1-t; return [u*u*g.x1+2*u*t*g.cx+t*t*g.x2, u*u*g.y1+2*u*t*g.cy+t*t*g.y2]; }
  let seed=7; function rnd(){ seed=(seed*1664525+1013904223)%4294967296; return seed/4294967296; }
  function placeLabels(){
    if(edges.length>80) return;
    const gs=new Map(edges.map(e=>[e,geometry(e)]));
    const pts=new Map(edges.map(e=>{ const g=gs.get(e), a=[]; for(let i=0;i<=24;i++) a.push(bez(g,i/24)); return [e,a]; }));
    const hit=(a,b)=>a[0]<b[2]&&b[0]<a[2]&&a[1]<b[3]&&b[1]<a[3];
    const nodeBoxes=nodes.map(n=>[[n.x-n.r-3,n.y-n.r-3,n.x+n.r+3,n.y+n.r+3],[n.x-n.label.length*3.8,n.y+n.r+3,n.x+n.label.length*3.8,n.y+n.r+21]]).flat();
    const placed=[];
    const offs=[0,-0.07,0.07,-0.14,0.14,-0.21,0.21,-0.28,0.28];
    edges.forEach(e=>{
      if(e.base===undefined) e.base=e.lt===undefined?0.5:e.lt;
      const g=gs.get(e), hw=e.label.length*3.3+8;
      let best=e.base, bc=1e9;
      offs.forEach((o,i)=>{
        const t=Math.min(0.82,Math.max(0.18,e.base+o)), [x,y]=bez(g,t);
        const box=[x-hw,y-12,x+hw,y+11];
        let c=i*0.6;
        edges.forEach(f=>{ if(f!==e && pts.get(f).some(p=>p[0]>box[0]&&p[0]<box[2]&&p[1]>box[1]&&p[1]<box[3])) c+=40; });
        nodeBoxes.forEach(b=>{ if(hit(box,b)) c+=40; });
        placed.forEach(b=>{ if(hit(box,b)) c+=60; });
        if(c<bc){ bc=c; best=t; }
      });
      e.lt=best;
      const [x,y]=bez(g,best); placed.push([x-hw,y-12,x+hw,y+11]);
    });
  }

  function paint(){
    placeLabels();
    nodes.forEach(n=>{
      n.g.setAttribute("transform","translate("+n.x.toFixed(1)+","+n.y.toFixed(1)+")");
      n.t.setAttribute("x", 0); n.t.setAttribute("y", n.r+16); n.t.setAttribute("text-anchor","middle");
      const touching = selected && edges.some(e=>(e.source===selected&&e.target===n.id)||(e.target===selected&&e.source===n.id));
      const dim = !nodeVisible(n) || (selected && n.id!==selected && !touching);
      n.g.setAttribute("class","node"+(dim?" dim":"")+(n.id===selected?" sel":""));
      n.c.setAttribute("r", n.id===selected ? n.r+3 : n.r);
    });
    edges.forEach(e=>{
      const g=geometry(e);
      const d="M"+g.x1.toFixed(1)+" "+g.y1.toFixed(1)+" Q"+g.cx.toFixed(1)+" "+g.cy.toFixed(1)+" "+g.x2.toFixed(1)+" "+g.y2.toFixed(1);
      e.path.setAttribute("d",d); e.hit.setAttribute("d",d);
      const inc = selected && (e.source===selected||e.target===selected);
      const on = inc || hovered===e;
      const dim = !edgeVisible(e) || (selected && !inc);
      e.path.setAttribute("class","edge"+(e.review?" review":"")+(on?" on":"")+(dim?" dim":""));
      e.path.setAttribute("marker-end","url(#"+(e.review?"ah-r":on?"ah-on":"ah")+")");
      e.lab.setAttribute("x",g.lx.toFixed(1)); e.lab.setAttribute("y",(g.ly+3).toFixed(1));
      e.lab.setAttribute("class","elabel"+(e.review?" review":"")+(dim?" dim":""));
      e.lab.style.display = (showAllLabels||on) ? "" : "none";
    });
    world.setAttribute("transform","translate("+view.x.toFixed(1)+","+view.y.toFixed(1)+") scale("+view.k.toFixed(3)+")");
  }

  // Simple force layout, run to rest before first paint.
  function step(alpha){
    for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i], b=nodes[j];
      let dx=a.x-b.x, dy=a.y-b.y; let d2=dx*dx+dy*dy;
      if(d2<1){ dx=rnd()-.5; dy=rnd()-.5; d2=1; }
      const d=Math.sqrt(d2), f=Math.min(40, 5200/d2)*alpha;
      dx/=d; dy/=d;
      if(!a.pin){ a.vx+=dx*f; a.vy+=dy*f; }
      if(!b.pin){ b.vx-=dx*f; b.vy-=dy*f; }
    }
    edges.forEach(e=>{
      const a=byId[e.source], b=byId[e.target];
      let dx=b.x-a.x, dy=b.y-a.y; const d=Math.hypot(dx,dy)||1;
      const f=(d-250)*0.02*alpha; dx/=d; dy/=d;
      if(!a.pin){ a.vx+=dx*f; a.vy+=dy*f; }
      if(!b.pin){ b.vx-=dx*f; b.vy-=dy*f; }
    });
    // Keep edge labels apart from each other and from unrelated names.
    const mids = edges.map(e=>{ const a=byId[e.source], b=byId[e.target]; return {e, x:(a.x+b.x)/2, y:(a.y+b.y)/2, a, b}; });
    const push = (ns, dx, dy, f)=>ns.forEach(n=>{ if(!n.pin){ n.vx+=dx*f; n.vy+=dy*f; } });
    for(let i=0;i<mids.length;i++){
      for(let j=i+1;j<mids.length;j++){
        const p=mids[i], q=mids[j];
        let dx=p.x-q.x, dy=p.y-q.y; const d=Math.hypot(dx,dy);
        if(d<130){ if(d<1){ dx=rnd()-.5; dy=1; } const u=Math.hypot(dx,dy); push([p.a,p.b],dx/u,dy/u,(130-d)*0.06*alpha); push([q.a,q.b],-dx/u,-dy/u,(130-d)*0.06*alpha); }
      }
      nodes.forEach(n=>{
        if(n===mids[i].a||n===mids[i].b) return;
        let dx=n.x-mids[i].x, dy=n.y-mids[i].y; const d=Math.hypot(dx,dy);
        if(d<115 && d>0.01){ if(!n.pin){ n.vx+=dx/d*(115-d)*0.08*alpha; n.vy+=dy/d*(115-d)*0.08*alpha; } }
      });
    }
    nodes.forEach(n=>{
      if(n.pin){ n.vx=n.vy=0; return; }
      n.vx+=(W/2-n.x)*0.012*alpha; n.vy+=(H/2-n.y)*0.012*alpha;
      n.vx*=0.78; n.vy*=0.78; n.x+=n.vx; n.y+=n.vy;
    });
  }
  function settle(n){ for(let i=0;i<n;i++) step(1-i/n*0.9); }
  function fit(){
    if(!nodes.length) return;
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    nodes.forEach(n=>{ x0=Math.min(x0,n.x-n.r); y0=Math.min(y0,n.y-n.r); x1=Math.max(x1,n.x+n.r,n.x+n.label.length*3.8); x0=Math.min(x0,n.x-n.label.length*3.8); y1=Math.max(y1,n.y+n.r+22); });
    const pad=48, w=Math.max(1,x1-x0), h=Math.max(1,y1-y0);
    const k=Math.min(1.6,(W-2*pad)/w,(H-2*pad)/h);
    view={k, x:(W-w*k)/2-x0*k, y:(H-h*k)/2-y0*k};
  }
  settle(320); fit(); paint();

  function select(n){
    selected = selected===n.id ? null : n.id;
    setDetail(selected ? selDetail() : DEFAULT);
    paint();
  }

  // Drag a name (with a short re-settle), pan the canvas, zoom at the cursor.
  let drag=null, pan=null, moved=false;
  function pt(ev){ const r=svg.getBoundingClientRect(); return {x:(ev.clientX-r.left)*W/r.width, y:(ev.clientY-r.top)*H/r.height}; }
  function startDrag(ev,n){ ev.preventDefault(); ev.stopPropagation(); moved=false; drag={n}; n.pin=true; window.addEventListener("pointermove",onMove); window.addEventListener("pointerup",endDrag); }
  function onMove(ev){
    if(!drag) return; moved=true;
    const p=pt(ev); drag.n.x=(p.x-view.x)/view.k; drag.n.y=(p.y-view.y)/view.k;
    step(0.25); paint();
  }
  function endDrag(){
    window.removeEventListener("pointermove",onMove); window.removeEventListener("pointerup",endDrag);
    if(drag && !moved) select(drag.n);
    drag=null;
  }
  svg.addEventListener("pointerdown", ev=>{ if(ev.target===svg||ev.target===bg){ const p=pt(ev); pan={x:p.x,y:p.y,vx:view.x,vy:view.y}; svg.style.cursor="grabbing"; } });
  window.addEventListener("pointermove", ev=>{ if(!pan) return; const p=pt(ev); view.x=pan.vx+(p.x-pan.x); view.y=pan.vy+(p.y-pan.y); paint(); });
  window.addEventListener("pointerup", ()=>{ pan=null; svg.style.cursor=""; });
  svg.addEventListener("wheel", ev=>{
    ev.preventDefault();
    const p=pt(ev), f=ev.deltaY<0?1.1:0.9, k=Math.min(3.5,Math.max(0.35,view.k*f)), r=k/view.k;
    view.x=p.x-(p.x-view.x)*r; view.y=p.y-(p.y-view.y)*r; view.k=k; paint();
  }, {passive:false});

  document.getElementById("legend").addEventListener("click", ev=>{
    const b=ev.target.closest("[data-type]"); if(!b) return;
    const t=b.dataset.type; hiddenTypes.has(t)?hiddenTypes.delete(t):hiddenTypes.add(t);
    b.style.opacity=hiddenTypes.has(t)?"0.4":"1"; paint();
  });
  document.getElementById("rel-filters").addEventListener("click", ev=>{
    const b=ev.target.closest("[data-rel]"); if(!b) return;
    const t=b.dataset.rel; hiddenRels.has(t)?hiddenRels.delete(t):hiddenRels.add(t);
    b.style.opacity=hiddenRels.has(t)?"0.4":"1"; paint();
  });
  search.addEventListener("input", paint);
  document.getElementById("reset").addEventListener("click", ()=>{
    nodes.forEach(n=>n.pin=false); selected=null; setDetail(DEFAULT); settle(200); fit(); paint();
  });

  function exportSvg(){
    const c=svg.cloneNode(true);
    c.setAttribute("xmlns",NS); c.setAttribute("width",W); c.setAttribute("height",H);
    c.removeAttribute("style");
    return new XMLSerializer().serializeToString(c);
  }
  document.getElementById("svg-dl").addEventListener("click", ()=>{
    const a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([exportSvg()],{type:"image/svg+xml"}));
    a.download="graph.svg"; a.click();
  });
  document.getElementById("png-dl").addEventListener("click", ()=>{
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement("canvas"); c.width=W*2; c.height=H*2;
      const x=c.getContext("2d"); x.drawImage(img,0,0,c.width,c.height);
      const a=document.createElement("a"); a.href=c.toDataURL("image/png"); a.download="graph.png"; a.click();
    };
    img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(exportSvg());
  });
})();
"""


def graph_payload(result: ExtractionResult, ontology: Ontology) -> dict:
    names = {e.name: (e.display_name or _pretty_name(e.name)) for e in result.entities}
    nodes = [
        {
            "id": e.name,
            "label": names[e.name],
            "type": e.entity_type,
            "kind": _pretty_type(e.entity_type),
            "color": ontology.color_for(e.entity_type),
        }
        for e in result.entities
    ]
    edges = []
    for r in result.relationships:
        sentence = _link_sentence(
            names.get(r.source, r.source), r.relation_type, names.get(r.target, r.target)
        )
        edges.append(
            {
                "source": r.source,
                "target": r.target,
                "type": r.relation_type,
                "label": _pretty_type(r.relation_type),
                "sentence": sentence,
                "evidence": r.description,
                "review": False,
            }
        )
    for item in result.review:
        if item.get("kind") != "relation":
            continue
        src = str(item.get("source") or "")
        tgt = str(item.get("target") or "")
        rel = str(item.get("type") or "NONE")
        if not src or not tgt:
            continue
        edges.append(
            {
                "source": src if src in names else src,
                "target": tgt if tgt in names else tgt,
                "type": rel,
                "label": _pretty_type(rel),
                "sentence": _review_sentence(item),
                "evidence": "",
                "review": True,
            }
        )
    return {
        "nodes": nodes,
        "edges": edges,
        "types": [
            {"id": t.id, "kind": _pretty_type(t.id), "color": t.color} for t in ontology.types
        ],
        "relations": sorted({e["type"] for e in edges}),
    }


def graph_markup(result: ExtractionResult, ontology: Ontology, title: str) -> str:
    payload = graph_payload(result, ontology)
    legend = "".join(
        f'<button type="button" data-type="{html.escape(t["id"])}">'
        f'<span class="dot" style="background:{html.escape(t["color"])}"></span>'
        f"{html.escape(t['kind'])}</button>"
        for t in payload["types"]
    )
    rels = "".join(
        f'<button type="button" data-rel="{html.escape(r)}">{html.escape(_pretty_type(r))}</button>'
        for r in payload["relations"]
        if r not in {"", "NONE", "NO_RELATION"}
    )
    blob = json.dumps(payload, ensure_ascii=False)
    return f"""
<section class="graph-block" aria-label="Knowledge graph">
<h2>Knowledge graph</h2>
<p class="muted">Drag a name to move it. Scroll to zoom, drag the background to pan. Click a name to list its links. Dashed amber lines are waiting for a person.</p>
<div class="toolbar">
  <input type="search" id="search" placeholder="Find a name" aria-label="Find a name">
  <button type="button" id="reset">Re-layout</button>
  <button type="button" id="svg-dl">Save SVG</button>
  <button type="button" id="png-dl">Save PNG</button>
</div>
<div class="legend" id="legend">{legend}</div>
<div class="toolbar" id="rel-filters">{rels}</div>
<div class="stage"><svg id="g" viewBox="0 0 1000 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Interactive knowledge graph">
  <style>{SVG_CSS}</style>
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 L9 5 L1 9 z" fill="#64748b"/></marker>
    <marker id="ah-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 L9 5 L1 9 z" fill="#f4f1ea"/></marker>
    <marker id="ah-r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 L9 5 L1 9 z" fill="#e5b567"/></marker>
  </defs>
  <rect id="bg" width="1000" height="560" fill="#0b1017"/>
  <g id="world"><g id="edges"></g><g id="labels"></g><g id="nodes"></g></g>
</svg>
<div class="key"><span><i></i>kept link</span><span><i class="dash"></i>waiting for a person</span></div></div>
<p class="detail muted" id="detail">Click a name to see its links. Hover a line to read the sentence behind it.</p>
</section>
<script>window.EDGEXTRACT_GRAPH = {blob};{JS}</script>
"""


def render_graph_page(result: ExtractionResult, ontology: Ontology, title: str) -> str:
    inner = graph_markup(result, ontology, title)
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}</style>
</head><body><main>
<h1>{html.escape(title)}</h1>
<p>This page is an interactive graph of the names and links the extractor kept.</p>
{inner}
</main></body></html>
"""


def write_graph(path: str | Path, result: ExtractionResult, ontology: Ontology, title: str) -> Path:
    out = Path(path)
    out.write_text(render_graph_page(result, ontology, title), encoding="utf-8")
    return out
