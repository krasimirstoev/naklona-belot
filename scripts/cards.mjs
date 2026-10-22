import {readFile,writeFile,mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import './branding.mjs';
await mkdir('public/cards',{recursive:true});
const suits={C:'♣',D:'♦',H:'♥',S:'♠'};
const ranks=['7','8','9','10','J','Q','K','A'];
const art={};for(const [r,name]of Object.entries({J:'jack',Q:'queen',K:'king'}))art[r]='data:image/webp;base64,'+(await readFile(`public/assets/${name}.webp`)).toString('base64');
const pipLayout={
  7:[[62,72],[138,72],[100,105],[62,145],[138,145],[62,218],[138,218]],
  8:[[62,72],[138,72],[100,108],[62,145],[138,145],[100,182],[62,218],[138,218]],
  9:[[62,69],[138,69],[62,119],[138,119],[100,145],[62,171],[138,171],[62,221],[138,221]],
  10:[[62,69],[138,69],[100,94],[62,119],[138,119],[62,171],[138,171],[100,196],[62,221],[138,221]]
};
for(const [s,symbol]of Object.entries(suits))for(const r of ranks){
  const color=s==='H'||s==='D'?'#ac3b31':'#222b28';
  let center='';
  if(art[r]) center=`<defs><clipPath id="top"><rect x="43" y="49" width="114" height="96"/></clipPath><clipPath id="bottom"><rect x="43" y="145" width="114" height="96"/></clipPath></defs><rect x="42" y="48" width="116" height="194" rx="2" fill="#e9d8ae" stroke="#b2a07c" stroke-width="1"/><image href="${art[r]}" x="43" y="49" width="114" height="171" clip-path="url(#top)"/><g clip-path="url(#bottom)"><image href="${art[r]}" x="43" y="49" width="114" height="171" transform="rotate(180 100 145)"/></g><path d="M43 145h114" stroke="#b2a07c"/><text x="55" y="72" font-size="24" fill="${color}">${symbol}</text><text x="55" y="72" font-size="24" fill="${color}" transform="rotate(180 100 145)">${symbol}</text>`;
  else if(r==='A')center=`<text x="100" y="166" text-anchor="middle" font-size="91" fill="${color}">${symbol}</text><path d="M66 206h68" stroke="#cbb98d"/><text x="100" y="225" text-anchor="middle" font-size="7" letter-spacing="3" fill="#a08c5f">НАКЛОНА</text>`;
  else center=pipLayout[r].map(([x,y])=>`<text x="${x}" y="${y+12}" text-anchor="middle" font-size="38" fill="${color}"${y>145?` transform="rotate(180 ${x} ${y})"`:''}>${symbol}</text>`).join('');
  const corner=`<text x="18" y="34" font-size="28" font-weight="bold" fill="${color}">${r}</text><text x="22" y="58" text-anchor="middle" font-size="24" fill="${color}">${symbol}</text>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="290" viewBox="0 0 200 290"><title>${r} ${symbol}</title><defs><linearGradient id="paper" x2=".2" y2="1"><stop stop-color="#fffdf5"/><stop offset="1" stop-color="#f0e9d7"/></linearGradient></defs><rect x="1" y="1" width="198" height="288" rx="11" fill="url(#paper)" stroke="#d4cbb4" stroke-width="2"/><g font-family="Georgia,DejaVu Serif,serif">${center}${corner}<g transform="rotate(180 100 145)">${corner}</g></g></svg>`;
  await writeFile(`public/cards/${s}-${r}.svg`,svg);
}
const back='data:image/webp;base64,'+(await readFile('public/assets/back-v2.webp')).toString('base64');
await writeFile('public/cards/back.svg',`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="290" viewBox="0 0 200 290"><defs><clipPath id="card"><rect x="6" y="6" width="188" height="278" rx="7"/></clipPath></defs><rect x="1" y="1" width="198" height="288" rx="11" fill="#eee6cd" stroke="#c9bea0" stroke-width="2"/><image href="${back}" x="6" y="6" width="188" height="278" preserveAspectRatio="xMidYMid slice" clip-path="url(#card)"/></svg>`);
for(const size of [192,512])await sharp('public/icon.svg').resize(size,size).png().toFile(`public/icon-${size}.png`);
console.log('32 карти, гръб и PWA икони са готови.');
