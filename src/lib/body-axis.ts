import type { Point, PoseSample } from "../types";

/** A visible silhouette is independent of permission to use its position in metrics. */
export function drawableSilhouette(sample: PoseSample | undefined) {
  return Boolean(sample?.contour && sample.contour.length >= 3 && sample.bbox
    && sample.status !== "missing" && sample.status !== "out_of_arena" && sample.source !== "predicted");
}

/** Geometric centerline, not named anatomy. Cross-sections stay inside the contour. */
export function estimatedBodyAxis(contour?: readonly Point[], directionHint?: Point): Point[] {
  if (!contour || contour.length < 3 || contour.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return [];
  const origin = { x: Math.min(...contour.map(p=>p.x)), y: Math.min(...contour.map(p=>p.y)) };
  const extent = { x: Math.max(...contour.map(p=>p.x))-origin.x, y: Math.max(...contour.map(p=>p.y))-origin.y };
  if (Math.min(extent.x, extent.y) < 3) return [];
  const scale = Math.min(1, 62/Math.max(extent.x, extent.y));
  const polygon = contour.map(p => ({ x: (p.x-origin.x)*scale+1, y: (p.y-origin.y)*scale+1 }));
  const w = Math.ceil(extent.x*scale)+3, h = Math.ceil(extent.y*scale)+3;
  const inside = (x: number, y: number) => {
    let yes = false;
    for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const a=polygon[i],b=polygon[j];
      if ((a.y>y)!==(b.y>y) && x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) yes=!yes;
    }
    return yes;
  };
  const pixels: Point[] = [];
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) if(inside(x,y)) pixels.push({x,y});
  if(pixels.length<16) return [];
  const mean={x:pixels.reduce((n,p)=>n+p.x,0)/pixels.length,y:pixels.reduce((n,p)=>n+p.y,0)/pixels.length};
  let xx=0,yy=0,xy=0;
  for(const p of pixels){xx+=(p.x-mean.x)**2;yy+=(p.y-mean.y)**2;xy+=(p.x-mean.x)*(p.y-mean.y);}
  const discriminant=Math.hypot(xx-yy,2*xy),major=(xx+yy+discriminant)/2,minor=(xx+yy-discriminant)/2;
  const round=major<1.6*Math.max(1,minor);
  // A round body still has a silhouette. Keep its last display direction, or
  // use an undirected horizontal section; neither assigns head/tail identity.
  const angle=round ? directionHint ? Math.atan2(directionHint.y,directionHint.x) : 0 : .5*Math.atan2(2*xy,xx-yy);
  const direction={x:Math.cos(angle),y:Math.sin(angle)};
  const projected=pixels.map(p=>({...p,t:p.x*direction.x+p.y*direction.y}));
  const sorted=projected.map(p=>p.t).sort((a,b)=>a-b);
  const low=sorted[Math.floor(sorted.length*.05)],high=sorted[Math.floor(sorted.length*.95)];
  const path:Point[]=[];
  for(let i=0;i<7;i++){
    const section=projected.filter(p=>p.t>=low+(high-low)*i/7 && p.t<=low+(high-low)*(i+1)/7);
    if(!section.length)continue;
    const center={x:section.reduce((n,p)=>n+p.x,0)/section.length,y:section.reduce((n,p)=>n+p.y,0)/section.length};
    const nearest=section.reduce((best,p)=>(p.x-center.x)**2+(p.y-center.y)**2<(best.x-center.x)**2+(best.y-center.y)**2?p:best);
    path.push({x:nearest.x,y:nearest.y});
  }
  let current:Point[]=path.length?[path[0]]:[],longest:Point[]=[];
  for(let i=1;i<path.length;i++){
    let inMask=0;
    for(let j=0;j<12;j++)if(inside(path[i-1].x+(path[i].x-path[i-1].x)*j/11,path[i-1].y+(path[i].y-path[i-1].y)*j/11))inMask++;
    if(inMask/12<.8){if(current.length>longest.length)longest=current;current=[];}
    current.push(path[i]);
  }
  if(current.length>longest.length)longest=current;
  return longest.length>=3 ? longest.map(p=>({x:(p.x-1)/scale+origin.x,y:(p.y-1)/scale+origin.y})) : [];
}
