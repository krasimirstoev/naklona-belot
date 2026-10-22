import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';

// Keep the original artwork intact. The SVG viewBox removes its transparent
// margins without redrawing, tracing or changing any of the brand's lettering.
const source=await readFile('public/assets/naklona-logo.png');
const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
let left=info.width,top=info.height,right=0,bottom=0;
for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
const width=right-left+1,height=bottom-top+1;
const png=`data:image/png;base64,${source.toString('base64')}`;
const original=`<image href="${png}" width="${info.width}" height="${info.height}"/>`;
export const brandFragment=(x,y,w,h)=>`<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${left} ${top} ${width} ${height}" preserveAspectRatio="xMidYMid meet">${original}</svg>`;
const mark=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}"><title>Наклона бар</title>${original}</svg>`;
await writeFile('public/assets/naklona-mark.svg',mark);

// Recessed cuts use the original logo's alpha: a dark upper edge, a light lower
// edge and translucent wood grooves. The tabletop's real grain remains visible.
const carved=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left-5} ${top-5} ${width+10} ${height+10}"><title>Наклона бар — издълбано в дървото</title><defs><filter id="knife" x="-10%" y="-15%" width="120%" height="130%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency=".045 .32" numOctaves="2" seed="12" result="grain"/>
<feDisplacementMap in="SourceAlpha" in2="grain" scale=".55" xChannelSelector="R" yChannelSelector="G" result="cut"/>
<feOffset in="cut" dx=".8" dy="1.2" result="lower"/><feComposite in="lower" in2="cut" operator="out" result="lip"/>
<feFlood flood-color="#f6d3a2" flood-opacity=".72"/><feComposite in2="lip" operator="in" result="light"/>
<feOffset in="cut" dx="-.6" dy="-.9" result="upper"/><feComposite in="upper" in2="cut" operator="out" result="edge"/>
<feFlood flood-color="#241107" flood-opacity=".9"/><feComposite in2="edge" operator="in" result="shadow"/>
<feFlood flood-color="#3b1e0d" flood-opacity=".68"/><feComposite in2="cut" operator="in" result="groove"/>
<feMerge><feMergeNode in="light"/><feMergeNode in="shadow"/><feMergeNode in="groove"/></feMerge>
</filter></defs><g filter="url(#knife)">${original}</g></svg>`;
await writeFile('public/assets/naklona-carved.svg',carved);
await writeFile('public/icon.svg',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Наклона — белот</title><rect width="512" height="512" rx="96" fill="#1a0f0f"/><rect x="65" y="111" width="382" height="290" rx="16" fill="#f5e6d3"/>${brandFragment(91,159,330,194)}</svg>`);
