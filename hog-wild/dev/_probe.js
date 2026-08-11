window.__probe = (() => {
  const hw = window.hogwild, A = hw.adapter, TH = A.THREE;
  const R = () => A.scene.renderer.domElement;
  function canvasSize(){ const c=R(); return [c.clientWidth||c.width, c.clientHeight||c.height]; }
  function pigMetrics(i){
    const pig = A.pigs[i]; const cam = A.scene.camera;
    const g = pig.group; g.updateMatrixWorld(true);
    let mesh=null; g.traverse(o=>{ if(o.isMesh && !mesh) mesh=o; });
    const bb = mesh.geometry.boundingBox;
    const [w,h]=canvasSize();
    let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9, nx0=1e9,nx1=-1e9,ny0=1e9,ny1=-1e9;
    const v=new TH.Vector3();
    for(const sx of [bb.min.x,bb.max.x]) for(const sy of [bb.min.y,bb.max.y]) for(const sz of [bb.min.z,bb.max.z]){
      v.set(sx,sy,sz); mesh.localToWorld(v); v.project(cam);
      nx0=Math.min(nx0,v.x); nx1=Math.max(nx1,v.x); ny0=Math.min(ny0,v.y); ny1=Math.max(ny1,v.y);
      const px=(v.x*0.5+0.5)*w, py=(-v.y*0.5+0.5)*h;
      x0=Math.min(x0,px); x1=Math.max(x1,px); y0=Math.min(y0,py); y1=Math.max(y1,py);
    }
    const depth = cam.position.distanceTo(new TH.Vector3(pig.p[0],pig.p[1],pig.p[2]));
    const tanH = Math.tan(cam.fov*0.5*Math.PI/180);
    const eyePx = 0.052*h/(depth*tanH);
    return {ndc:[nx0,nx1,ny0,ny1].map(n=>+n.toFixed(3)), px:[Math.round(x1-x0),Math.round(y1-y0)],
            depth:+depth.toFixed(2), eyePx:+eyePx.toFixed(1),
            worst:+Math.max(Math.abs(nx0),Math.abs(nx1),Math.abs(ny0),Math.abs(ny1)).toFixed(3)};
  }
  function chipInfo(){
    const kr = R().getBoundingClientRect();
    const card = document.getElementById('resultCard');
    const cr = (card && !card.hidden && card.offsetParent) ? card.getBoundingClientRect() : null;
    return [0,1].map(i=>{
      const el = document.getElementById('pigChip'+i);
      if(!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {show:el.classList.contains('show'), off:el.classList.contains('offscreen'),
        opacity:+cs.opacity, text:el.textContent.trim(),
        rect:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)],
        inCanvas: r.left>=kr.left-0.5 && r.right<=kr.right+0.5 && r.top>=kr.top-0.5 && r.bottom<=kr.bottom+0.5,
        onCard: !!cr && r.right>cr.left && r.left<cr.right && r.bottom>cr.top && r.top<cr.bottom};
    }).concat([cr?{card:[Math.round(cr.left),Math.round(cr.top),Math.round(cr.right),Math.round(cr.bottom)]}:{card:null}]);
  }
  function snap(tag){
    const cam=A.scene.camera; const mid=[(A.pigs[0].p[0]+A.pigs[1].p[0])/2,(A.pigs[0].p[1]+A.pigs[1].p[1])/2,(A.pigs[0].p[2]+A.pigs[1].p[2])/2];
    return {t:Math.round(performance.now()-window.__t0), tag, mode:A.mode,
      cam:[cam.position.x,cam.position.y,cam.position.z].map(n=>+n.toFixed(2)),
      distMid:+cam.position.distanceTo(new TH.Vector3(...mid)).toFixed(2),
      pigs:[pigMetrics(0),pigMetrics(1)], chips:chipInfo(),
      card:(()=>{const c=document.getElementById('resultCard'); return c&&!c.hidden?{h:document.getElementById('resultHeadline').textContent,d:document.getElementById('resultDetail').textContent}:null})(),
      turnScore: (document.getElementById('turnPoints')||{textContent:''}).textContent };
  }


  /* ---- readPixels measurement, the way the critic measured ---------------- */
  function readBuf(){
    const gl = A.scene.renderer.getContext();
    A.scene.render();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    return {buf,w,h};
  }
  const LUM = (r,g,b)=>0.2126*r+0.7152*g+0.0722*b;
  function sampleWorld(B, x, y, z){
    const cam=A.scene.camera; const v=new TH.Vector3(x,y,z).project(cam);
    if(Math.abs(v.x)>1||Math.abs(v.y)>1) return null;
    const px=Math.round((v.x*0.5+0.5)*(B.w-1));
    const py=Math.round((v.y*0.5+0.5)*(B.h-1)); // readPixels is bottom-up
    const o=(py*B.w+px)*4;
    return {lum:+LUM(B.buf[o],B.buf[o+1],B.buf[o+2]).toFixed(1), rgb:[B.buf[o],B.buf[o+1],B.buf[o+2]], px, py};
  }
  const median = a => { a=a.slice().sort((x,y)=>x-y); return a.length?+a[Math.floor(a.length/2)].toFixed(1):null; };
  /** median luminance per radius over `nb` bearings — the zone hierarchy test */
  function boardLum(radii=[0.5,1.0,1.5,2.0,2.5,2.6,2.9,3.2,3.5,3.8,4.0,4.2,4.4,4.55,4.7,5.0,5.5,6.2], nb=48){
    const B=readBuf(); const out=[];
    for(const r of radii){
      const vals=[];
      for(let i=0;i<nb;i++){ const a=2*Math.PI*i/nb; const s=sampleWorld(B, r*Math.cos(a), 0.008, r*Math.sin(a)); if(s) vals.push(s.lum); }
      out.push({r, n:vals.length, med:median(vals), min:vals.length?+Math.min(...vals).toFixed(1):null, max:vals.length?+Math.max(...vals).toFixed(1):null});
    }
    return out;
  }
  /** a horizontal scanline of raw buffer luminance across the board's rim */
  function rimProfile(bearingDeg=0, r0=4.2, r1=5.6, steps=22){
    const B=readBuf(); const a=bearingDeg*Math.PI/180; const out=[];
    for(let i=0;i<=steps;i++){ const r=r0+(r1-r0)*i/steps; const s=sampleWorld(B, r*Math.cos(a),0.008,r*Math.sin(a)); out.push(s?{r:+r.toFixed(2),lum:s.lum}:null); }
    return out;
  }
  /** dead-black share of the canvas */
  function blackShare(thresh=12){
    const B=readBuf(); let n=0; const total=B.w*B.h;
    for(let i=0;i<total;i++){ const o=i*4; if(LUM(B.buf[o],B.buf[o+1],B.buf[o+2])<thresh) n++; }
    return +(100*n/total).toFixed(2);
  }
  function busyUntil(t){ while(performance.now()<t){} }
  /* A macrotask yield that is NOT timer-throttled: this tab is hidden, so rAF
     never fires and setTimeout clamps to ~1s. MessageChannel keeps the game's
     own promise chain advancing while we step the render loop by hand. */
  function yieldTask(){ return new Promise(r=>{const c=new MessageChannel();c.port1.onmessage=()=>r();c.port2.postMessage(0);}); }
  async function drive(totalMs, sampleEvery=100){
    window.__log=[]; window.__t0=performance.now();
    const end=performance.now()+totalMs; let lastSample=-1e9;
    while(performance.now()<end){
      const now=performance.now();
      try{ A.step(now); }catch(e){ window.__log.push({err:String(e)}); }
      if(now-lastSample>=sampleEvery){ lastSample=now; try{ window.__log.push(snap()); }catch(e){ window.__log.push({err:String(e)}); } }
      busyUntil(now+8);
      await yieldTask();
    }
    return window.__log.length;
  }
  async function runDriven(outcome, totalMs=8000, sampleEvery=100){
    if(outcome) hw.force(outcome);
    hw.toss({});
    return await drive(totalMs, sampleEvery);
  }
  async function run(outcome, ms=7000, every=120){
    window.__log=[]; window.__t0=performance.now();
    if(outcome) hw.force(outcome);
    const p = hw.toss({});
    const iv = setInterval(()=>{ try{ window.__log.push(snap()); }catch(e){ window.__log.push({err:String(e)}); } }, every);
    await new Promise(r=>setTimeout(r, ms));
    clearInterval(iv);
    await p.catch(()=>{});
    return window.__log.length;
  }
  return {run, drive, runDriven, readBuf, sampleWorld, boardLum, rimProfile, blackShare, snap, pigMetrics, chipInfo, canvasSize,
    summary:()=>window.__log.map(s=>({t:s.t,mode:s.mode,d:s.distMid,camY:s.cam[1],
      p0:s.pigs[0].worst,p1:s.pigs[1].worst,e0:s.pigs[0].eyePx,px0:s.pigs[0].px,px1:s.pigs[1].px,
      c:s.chips.slice(0,2).map(c=>c&&(c.show?(c.off?'off':'ON'):'-')).join('/'), card:!!s.card}))};
})();
'probe ready'
