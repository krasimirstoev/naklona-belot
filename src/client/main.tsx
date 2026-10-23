import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BID_LABEL, CONTRACT_LABEL, DIFFICULTY_LABEL, NAMES, SYMBOL, SPEED_LABEL, type Action, type AnnouncementEvent, type Bid, type Card, type Difficulty, type Settings, type Speed, type StateResponse, type View } from '../game/types';
import './style.css';
import {resolveDeclarations} from '../game/declaration-resolution';

const requestId=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(20)),b=>b.toString(16).padStart(2,'0')).join('');
const suitOf=(c:Card)=>c.split('-')[0] as keyof typeof SYMBOL;
const cardName=(c:Card)=>`${c.split('-')[1]} ${CONTRACT_LABEL[suitOf(c)]}`;
const difficulties: Difficulty[]=['easy','medium','hard'];
const difficultyText={easy:'Спокойна игра, без напрежение.',medium:'Достойни съперници. Още по-добра компания.',hard:'За тези, които броят всяка карта.'};
function CardImage({card,className=''}:{card:Card|'back';className?:string}) {
  return <img className={`card-image ${className}`} src={`/cards/${card}.svg`} alt={card==='back'?'Обърната карта':cardName(card)} draggable={false}/>;
}
function TrickArea({game,reduced}:{game:View;reduced:boolean}) {
  const previous=useRef(game),layer=useRef<HTMLDivElement>(null);
  const [collecting,setCollecting]=useState<View['tricks'][number]|null>(null);
  useLayoutEffect(()=>{
    const before=previous.current;previous.current=game;
    if(!reduced&&before.trick.length===4&&game.tricks.length===before.tricks.length+1){
      setCollecting(game.tricks.at(-1)!);
    }
  },[game,reduced]);
  useLayoutEffect(()=>{
    if(!collecting)return;
    if(reduced||matchMedia('(prefers-reduced-motion: reduce)').matches){setCollecting(null);return;}
    const element=layer.current;
    const target=element?.closest('.game-table')?.querySelector(collecting.winner===0?'.your-player':`.player-${collecting.winner} .player-info`);
    if(!element||!target){setCollecting(null);return;}
    const bounds=element.getBoundingClientRect(),destination=target.getBoundingClientRect();
    const scale=bounds.width/element.offsetWidth;
    const animations=Array.from(element.children,card=>{
      const rect=card.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
      return card.animate([
        {translate:'0px 0px',scale:1,opacity:1},
        {translate:`${(bounds.x+bounds.width/2-x)/scale}px ${(bounds.y+bounds.height/2-y)/scale}px`,scale:.85,opacity:1,offset:.28},
        {translate:`${(destination.x+destination.width/2-x)/scale}px ${(destination.y+destination.height/2-y)/scale}px`,scale:.2,opacity:0}
      ],{duration:460,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});
    });
    void Promise.all(animations.map(a=>a.finished)).then(()=>setCollecting(null),()=>{});
    return()=>animations.forEach(a=>a.cancel());
  },[collecting,reduced]);
  return <div className="trick-area" aria-label="Карти на масата">
    {game.trick.map(p=><div key={`${game.tricks.length}-${p.player}`} className={`played-card played-${p.player}`}><CardImage card={p.card}/></div>)}
    {collecting&&<div ref={layer} className="collecting-trick" data-winner={collecting.winner} aria-hidden="true">{collecting.plays.map(p=><div key={p.player} className={`played-card played-${p.player}`}><CardImage card={p.card}/></div>)}</div>}
    {!game.trick.length&&!collecting&&game.phase==='playing'&&<span className="lead-hint">{game.turn===0?'Твоят ход.':`${NAMES[game.turn]} избира карта.`}</span>}
    {game.phase==='bidding'&&<div className="bidding-center"><span>ПЕТ КАРТИ. ЕДНА ОБЯВА.</span><strong>{game.turn===0?'Ти си на ред.':`${NAMES[game.turn]} мисли…`}</strong></div>}
  </div>;
}
function EventText({event}:{event:AnnouncementEvent}) {
  const symbol=event.bid&&event.bid in SYMBOL?SYMBOL[event.bid as keyof typeof SYMBOL]:null;
  return <><span className={event.bid==='H'||event.bid==='D'?'red-suit':'suit-symbol'}>{symbol}</span>{event.text}</>;
}
function PlayerCall({events,player}:{events:AnnouncementEvent[];player:number}) {
  const own=events.filter(e=>e.player===player),bid=own.filter(e=>e.kind==='bid').at(-1),extra=own.filter(e=>e.kind!=='bid');
  return <div className="player-call" data-player={player} aria-label={`Обяви на ${NAMES[player]}`}>
    {bid?<strong className={`call-label call-${bid.bid}`}><EventText event={bid}/></strong>:<span className="not-called">Още не е обявявал</span>}
    {extra.length>0&&<div className="call-extras">{extra.map(e=><strong key={e.id}>{e.text}</strong>)}</div>}
  </div>;
}
function DeclarationResults({game}:{game:View}) {
  if(!game.announcements.length)return null;
  const statuses=resolveDeclarations(game.announcements,game.higherFourWins);
  const ranks:Record<string,string>={'7':'седмица','8':'осмица','9':'деветка','10':'десетка',J:'вале',Q:'дама',K:'поп',A:'асо'};
  return <div className="declaration-results" data-testid="declaration-results"><h4>Кой какво обяви — анонси</h4><ul>{game.announcements.map((a,i)=>{
    const top=a.cards.at(-1)?.split('-')[1];
    const label=a.kind==='sequence'?`${a.cards.length===3?'Терца':a.cards.length===4?'Кварта':'Квинта'} до ${ranks[top??'']??top}`:a.label;
    const status=statuses[i];
    return <li key={`${a.player}-${a.id}`} data-status={status}><strong>{NAMES[a.player]} · {a.player%2===0?'Ние':'Те'}</strong><span>{label}</span><span className="declaration-cards">{a.cards.map(c=>`${c.split('-')[1]}${SYMBOL[suitOf(c)]}`).join(' · ')}</span><small>{status==='counted'?`Зачита се: +${a.value}`:status==='tied'?'Отпада: равни най-силни анонси в двата отбора':`Отпада: противникът има по-силн${a.kind==='sequence'?'а поредица':'о каре'}`}</small></li>;
  })}</ul><p>Най-силната поредица запазва всички поредици на своя отбор. Каретата се сравняват отделно.</p></div>;
}
function App() {
  const [game,setGame]=useState<View|null>(null),[loaded,setLoaded]=useState(false),[screen,setScreen]=useState<'lobby'|'table'>('lobby');
  const [difficulty,setDifficulty]=useState<Difficulty>(()=>{const d=localStorage.getItem('difficulty');return difficulties.includes(d as Difficulty)?d as Difficulty:'medium';});
  const [settings,setSettings]=useState<Settings>({speed:'normal',allowContraEscape:false,multiplyAnnouncements:false,higherFourWins:true,revision:0}),[settingBusy,setSettingBusy]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[connected,setConnected]=useState(false);
  const [modal,setModal]=useState<'rules'|'about'|'last'|'new'|'settings'|null>(null);
  const [ruleDraft,setRuleDraft]=useState<Partial<Pick<Settings,'allowContraEscape'|'multiplyAnnouncements'|'higherFourWins'>>>({});
  const [declared,setDeclared]=useState<string[]>([]),[belot,setBelot]=useState(false);
  const [sound,setSound]=useState(()=>localStorage.getItem('sound')==='true');
  const [reduced,setReduced]=useState(()=>localStorage.getItem('reduced')==='true'||matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [liveAnnouncement,setLiveAnnouncement]=useState('');
  const log=useRef<HTMLOListElement>(null);
  const actionPending=useRef(false),lastTouch=useRef(-Infinity),touchTap=useRef<{card:Card;at:number}|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),current=useRef<View|null>(null),audio=useRef<AudioContext|null>(null),soundRef=useRef(sound);
  const seen=useRef({gameId:'',eventId:0});
  const receive=(data:StateResponse,notify=true)=>{
    setSettings(current=>data.settings.revision>=current.revision?{...data.settings,allowContraEscape:data.settings.allowContraEscape??false,multiplyAnnouncements:data.settings.multiplyAnnouncements??false,higherFourWins:data.settings.higherFourWins??true}:current);const g=data.game;
    if(g&&current.current?.id===g.id&&current.current.revision>g.revision)return;
    const latest=g?.events.at(-1)?.id??0;
    if(g&&notify&&seen.current.gameId===g.id&&latest>seen.current.eventId){
      setLiveAnnouncement(g.events.filter(e=>e.id>seen.current.eventId).map(e=>`${NAMES[e.player]}: ${e.text}`).join('. '));
    }else if(!notify||seen.current.gameId!==g?.id)setLiveAnnouncement('');
    seen.current={gameId:g?.id??'',eventId:latest};
    if(g&&current.current&&g.revision!==current.current.revision&&soundRef.current&&audio.current){
      const ctx=audio.current,osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.value=g.turn===0?660:330;gain.gain.setValueAtTime(.035,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.12);osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.13);
    }
    current.current=g;setGame(g);
  };
  useEffect(()=>{
    let active=true,initialized=false,source:EventSource|undefined,retry:ReturnType<typeof setTimeout>|undefined;
    const init=async()=>{
      if(!active)return;clearTimeout(retry);source?.close();
      if(!navigator.onLine){setConnected(false);setLoaded(true);retry=setTimeout(()=>void init(),1500);return;}
      try{
        const r=await fetch('/api/state');if(!r.ok)throw new Error('Сървърът не отговаря.');
        const data:StateResponse=await r.json();if(!active)return;receive(data,false);
        if(!initialized){if(data.game)setScreen('table');initialized=true;}setLoaded(true);
        source=new EventSource('/api/events');source.onopen=()=>{setConnected(true);setError('');};
        source.onerror=()=>{source?.close();setConnected(false);if(active)retry=setTimeout(()=>void init(),1500);};
        source.onmessage=e=>{try{receive(JSON.parse(e.data));}catch{setError('Неуспешно обновяване. Презареди страницата.');}};
      }catch{if(active){setConnected(false);setLoaded(true);setError('Няма връзка със сървъра. Опитваме отново…');retry=setTimeout(()=>void init(),1500);}}
    };
    const offline=()=>{source?.close();setConnected(false);},online=()=>{void init();};
    window.addEventListener('offline',offline);window.addEventListener('online',online);void init();
    return()=>{active=false;clearTimeout(retry);source?.close();window.removeEventListener('offline',offline);window.removeEventListener('online',online);};
  },[]);
  useEffect(()=>{touchTap.current=null;setDeclared([]);setBelot(false);},[game?.revision,game?.id]);
  useEffect(()=>{if(log.current)log.current.scrollTop=log.current.scrollHeight;},[game?.events.at(-1)?.id,game?.id,screen]);
  useEffect(()=>{localStorage.setItem('difficulty',difficulty);},[difficulty]);
  useEffect(()=>{soundRef.current=sound;localStorage.setItem('sound',String(sound));},[sound]);
  useEffect(()=>{localStorage.setItem('reduced',String(reduced));document.documentElement.dataset.reduced=String(reduced);},[reduced]);
  useEffect(()=>{if(modal)dialog.current?.showModal();else dialog.current?.close();},[modal]);
  useEffect(()=>{const unlock=()=>{if(soundRef.current){audio.current??=new AudioContext();void audio.current.resume();}};window.addEventListener('pointerdown',unlock,{once:true});return()=>window.removeEventListener('pointerdown',unlock);},[]);
  async function send(path:string,body:unknown,setting=false){
    if(setting)setSettingBusy(true);else setBusy(true);setError('');
    try{
      const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await r.json();
      if('game'in data)receive(data);if(!r.ok)throw new Error(data.error??'Действието не беше прието.');return true;
    }catch(e){setError(e instanceof TypeError?'Връзката прекъсна. Играта е запазена; изчакай свързването.':(e as Error).message);return false;}
    finally{if(setting)setSettingBusy(false);else setBusy(false);}
  }
  async function changeRule(rule:'allowContraEscape'|'multiplyAnnouncements'|'higherFourWins',enabled:boolean){
    setRuleDraft({[rule]:enabled});
    try{await send('/api/settings',{[rule]:enabled,requestId:requestId()},true);}
    finally{setRuleDraft({});}
  }
  async function start(){if(await send('/api/games',{difficulty,requestId:requestId()})){setScreen('table');setModal(null);}}
  async function act(action:Action){
    if(!game||busy||actionPending.current)return;
    actionPending.current=true;
    try{await send('/api/action',{gameId:game.id,revision:game.revision,requestId:requestId(),action});}
    finally{actionPending.current=false;}
  }
  function playCard(card:Card){
    if(!game||game.phase!=='playing'||game.turn!==0||busy||!connected||actionPending.current)return;
    if(!game.legalCards.includes(card)){setError('Тази карта не е допустима: отговори на боята и качи или цакай според правилата.');return;}
    void act({type:'play',card,declare:declared,belot:belot&&game.belotCards.includes(card)});
  }
  function touchCard(card:Card,event:React.PointerEvent){
    if(event.pointerType!=='touch')return;
    const now=performance.now();lastTouch.current=now;
    const previous=touchTap.current;touchTap.current={card,at:now};
    if(previous?.card===card&&now-previous.at<=450){touchTap.current=null;playCard(card);}
  }
  function toggleSound(){if(!sound){audio.current??=new AudioContext();void audio.current.resume();}setSound(!sound);}
  const isTable=screen==='table'&&game,turn=game?.turn===0&&['bidding','playing'].includes(game.phase),last=game?.tricks.at(-1),latest=game?.results.at(-1),ended=game&&['roundEnd','matchEnd'].includes(game.phase);
  const effectiveMultiplier=ended&&latest?(latest.capot?1:latest.multiplier):game?.multiplier??1;
  const events=game?.events.filter(e=>e.round===game.round)??[],lastEvent=game?.events.at(-1);
  const lastGroup=lastEvent?game!.events.filter(e=>e.revision===lastEvent.revision&&e.player===lastEvent.player&&e.round===lastEvent.round&&(lastEvent.revision!==-1||e.id===lastEvent.id)):[];
  const difficultyPicker=<div className="difficulty-picker" role="group" aria-label="Трудност">{difficulties.map((d,i)=><button key={d} className={difficulty===d?'selected':''} onClick={()=>setDifficulty(d)} aria-pressed={difficulty===d}><span className="level-bars">{[0,1,2].map(n=><i key={n} className={n<=i?'lit':''}/>)}</span>{DIFFICULTY_LABEL[d]}</button>)}</div>;
  const speedPicker=<div className="speed-control"><span className="control-label">ТЕМПО НА ИГРАТА</span><div className="speed-picker" role="group" aria-label="Скорост на играта">{(['slow','normal','fast'] as Speed[]).map(s=><button key={s} aria-pressed={settings.speed===s} className={settings.speed===s?'selected':''} disabled={settingBusy||!connected} onClick={()=>void send('/api/settings',{speed:s,requestId:requestId()},true)}>{SPEED_LABEL[s]}</button>)}</div></div>;
  return <div className={`app ${isTable?'at-table':''}`}>
    <header className="header">
      <button className="brand" onClick={()=>setScreen('lobby')} aria-label="Наклона — начало"><img className="brand-logo" src="/assets/naklona-mark.svg" alt="Наклона бар" width="176" height="103" draggable={false}/></button>
      <nav aria-label="Основна навигация"><button className={!modal?'active':''} onClick={()=>setScreen(game?'table':'lobby')}>Масата</button><button onClick={()=>setModal('rules')}>Как се играе</button><button className="about-nav" onClick={()=>setModal('about')}>За играта</button></nav>
      <div className="header-tools"><button className="icon-button" aria-label="Опции на играта" title="Опции на играта" onClick={()=>setModal('settings')}>⚙</button><span className="local-tag"><i/> ТВОЯТА МАСА</span><button className="icon-button" aria-label={sound?'Изключи звука':'Включи звука'} onClick={toggleSound} title="Звук">{sound?'♫':'♪'}<span className={!sound?'sound-off':''}/></button></div>
    </header>
    <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="announcement-live">{liveAnnouncement}</div>
    {error&&<div className="error-banner" role="alert">{error}<button onClick={()=>setError('')} aria-label="Затвори съобщението">×</button></div>}
    {!loaded?<main className="loading"><span>♠</span><p>Подготвяме масата…</p></main>:!isTable?<main className="lobby">
      <section className="welcome"><div className="eyebrow">НАКЛОНА · ЕДНА МАСА, МНОГО ИСТОРИИ</div><h1>Добрата игра<br/>върви с<br/><em>добра компания.</em></h1><p className="intro">Плотът помни и по-добри ръце.<br/>Сядай — тази вечер може да е твоята.</p>
        <div className="start-panel"><span className="control-label">КОЙ Е НАСРЕЩА?</span>{difficultyPicker}<p className="difficulty-description">{difficultyText[difficulty]}</p>{speedPicker}<button className="primary start-button" disabled={busy||!connected} onClick={()=>game?setModal('new'):void start()}>Сядам на масата <span>→</span></button>{game&&<button className="continue-button" onClick={()=>setScreen('table')}>Продължи запазената партия →</button>}<div className="start-note">Ти + 3 бота <i/> Български белот <i/> До 151</div></div>
      </section>
      <section className="lobby-scene" aria-label="Дървена барова маса"><div className="table-sign">МАСА 01 <span>ЗАПАЗЕНА ЗА ДОБРА КОМПАНИЯ</span></div><div className="preview-table"><img className="table-brand" src="/assets/naklona-carved.svg" alt="Наклона бар — издълбано в дървото" width="186" height="113" draggable={false}/><div className="preview-cards">{(['S-A','H-K','S-Q','H-J','S-10'] as Card[]).map((c,i)=><div key={c} style={{'--i':i} as React.CSSProperties}><CardImage card={c}/></div>)}</div></div><div className="scene-seat seat-top"><span className="avatar">Б</span><div>Борис<small>С ТЕБ В ОТБОРА</small></div></div><div className="scene-seat seat-left"><span className="avatar">В</span><div>Виктор<small>ГОТОВ ЗА ИГРА</small></div></div><div className="scene-seat seat-right"><span className="avatar">Н</span><div>Никола<small>ГОТОВ ЗА ИГРА</small></div></div><div className="your-seat">ТВОЕТО МЯСТО Е ТУК ↓</div></section>
      <div className="lobby-features"><span><b>32</b> карти на стария плот</span><span><b>3</b> нива на майсторлък</span><span>Без регистрация. Просто игра.</span></div>
    </main>:<main className="game-layout">
      <section className="game-main">
        <div className="table-heading"><div><span className="eyebrow">МАСА 01 · РАЗДАВАНЕ {game.round}</span><h1>Една добра ръка.</h1></div><span className="difficulty-tag">{DIFFICULTY_LABEL[game.difficulty]}</span></div>
        <div className="announcement-banner" data-testid="announcement-banner"><span className="banner-label">{lastEvent?lastEvent.round===game.round?'ПОСЛЕДНО ОБЯВЯВАНЕ':`ОТ РАЗДАВАНЕ ${lastEvent.round}`:'ОБЯВЯВАНЕТО ЗАПОЧВА'}</span>{lastEvent?<div><span className="banner-player">{NAMES[lastEvent.player]}:</span><strong>{lastGroup.map((e,i)=><React.Fragment key={e.id}>{i>0&&<span className="event-separator"> · </span>}<EventText event={e}/></React.Fragment>)}</strong></div>:<div><strong>Кой какво ще каже?</strong><span className="banner-awaiting">{NAMES[game.turn]} е на ред.</span></div>}</div>
        <div className="contract-strip" data-testid="contract"><span>{game.contract?'ИГРАЕМ':'ПРЕДСТОИ'}</span><strong>{game.contract?`${game.contract in SYMBOL?SYMBOL[game.contract as keyof typeof SYMBOL]+' ':''}${CONTRACT_LABEL[game.contract]}`:'Избираме обява'}</strong>{game.declarer!==null&&<span>Обявил: <b>{NAMES[game.declarer]}</b></span>}{effectiveMultiplier>1&&<strong className="multiplier">{effectiveMultiplier===2?'КОНТРА ×2':'РЕКОНТРА ×4'}</strong>}</div>
        <div className="game-table-wrap"><div className="game-table"><img className="table-brand" src="/assets/naklona-carved.svg" alt="Наклона бар — издълбано в дървото" width="186" height="113" draggable={false}/>
          {[1,2,3].map(p=><div key={p} className={`player player-${p} ${game.turn===p&&!ended?'is-turn':''}`}><div className="player-info"><span className={`avatar ${p===2?'partner':''}`}>{NAMES[p][0]}</span><div><strong>{NAMES[p]}</strong><small>{p===2?'Твоят партньор':'Съперник'}{game.dealer===p?' · Раздава':''}</small></div>{game.turn===p&&!ended&&<span className="thinking"><i/><i/><i/></span>}</div><PlayerCall events={events} player={p}/><div className="bot-hand" aria-label={`${game.counts[p]} карти`}>{Array.from({length:game.counts[p]},(_,i)=><CardImage key={i} card="back"/>)}<span>{game.counts[p]}</span></div></div>)}
          <TrickArea key={`${game.id}-${game.round}`} game={game} reduced={reduced}/>
          <div className={`your-player ${turn?'is-turn':''}`}><span className="avatar">Т</span><strong>Ти</strong>{game.dealer===0&&<small>Раздаваш</small>}<PlayerCall events={events} player={0}/>{turn&&<i className="turn-dot"/>}</div>
        </div></div>
        <div className="hand-section"><div className="hand-caption"><span>{game.phase==='bidding'?'ТВОИТЕ ПЪРВИ ПЕТ':'ТВОИТЕ КАРТИ'}</span><span>{game.contract?CONTRACT_LABEL[game.contract]:'Обяви, когато си на ред'}</span></div><div className="hand" role="group" aria-label="Твоите карти">{game.hand.map((c,i)=><button key={c} className={`hand-card ${game.phase==='playing'&&turn&&!game.legalCards.includes(c)?'unplayable':''}`} style={{'--angle':`${(i-(game.hand.length-1)/2)*1.4}deg`,'--lift':`${Math.abs(i-(game.hand.length-1)/2)*1.5}px`} as React.CSSProperties} aria-label={`${cardName(c)}${game.phase==='playing'&&!game.legalCards.includes(c)?' — не може да се играе сега':''}`} aria-disabled={!turn||busy||!connected||!game.legalCards.includes(c)} aria-keyshortcuts="Enter Space" title="Двоен клик / двойно докосване за игра; Enter или Space с клавиатура" onDoubleClick={e=>{e.preventDefault();if(performance.now()-lastTouch.current>700)playCard(c);}} onClick={e=>{if(e.detail===0)playCard(c);}} onPointerUp={e=>touchCard(c,e)} onPointerCancel={()=>{touchTap.current=null;}}><CardImage card={c}/></button>)}</div></div>
        <div className="action-zone" aria-live="polite">
          {ended?<div className="round-action"><span>{game.phase==='matchEnd'?(game.scores[0]>game.scores[1]?'Победа за вас! Наздраве!':'Този път съперниците спечелиха.'):'Раздаването приключи.'}</span><button className="primary" disabled={busy||!connected} onClick={()=>game.phase==='matchEnd'?setModal('new'):void act({type:'next'})}>{game.phase==='matchEnd'?'Нова партия':'Следващо раздаване'} →</button></div>:game.phase==='bidding'?<><div className="status-line"><i className={turn?'turn-dot':'wait-dot'}/>{turn?'Твой ред е да обявиш.':`${NAMES[game.turn]} обмисля обявата…`}</div><div className="bid-buttons">{(['C','D','H','S','NT','AT','contra','recontra','pass'] as Bid[]).filter(b=>!['contra','recontra'].includes(b)||game.legalBids.includes(b)||(b==='recontra'&&game.multiplier===2&&game.declarer!==null&&game.declarer%2===0)).map(b=><button key={b} aria-label={BID_LABEL[b]} className={`bid-button ${b==='pass'?'pass-button':''} ${b==='D'||b==='H'?'red-suit':''}`} disabled={!turn||!game.legalBids.includes(b)||busy||!connected} onClick={()=>void act({type:'bid',bid:b})}>{b.length===1?<><b aria-hidden="true">{SYMBOL[b as keyof typeof SYMBOL]}</b><span>{BID_LABEL[b]}</span></>:BID_LABEL[b]}</button>)}</div></>:<><div className="play-controls" data-testid="play-status"><div className="status-line"><i className={turn?'turn-dot':'wait-dot'}/>{game.phase==='trick'?game.message:turn?'Твой ред е. Двоен клик или двойно докосване върху карта.':`${NAMES[game.turn]} е на ход…`}</div></div>{turn&&game.declarations.length>0&&<div className="announcements"><span>Обяви с първата карта:</span>{game.declarations.map(d=><label key={d.id}><input type="checkbox" disabled={!declared.includes(d.id)&&game.declarations.some(other=>declared.includes(other.id)&&other.cards.some(c=>d.cards.includes(c)))} checked={declared.includes(d.id)} onChange={e=>setDeclared(e.target.checked?[...declared,d.id]:declared.filter(id=>id!==d.id))}/>{d.label} <small>+{d.value}</small></label>)}</div>}{turn&&game.belotCards.some(c=>game.legalCards.includes(c))&&<label className="belot-option"><input type="checkbox" checked={belot} onChange={e=>setBelot(e.target.checked)}/>Обявявам белот <b>+20</b><small>при K/Q {Array.from(new Set(game.belotCards.filter(c=>game.legalCards.includes(c)).map(c=>SYMBOL[suitOf(c)]))).join(', ')}</small></label>}</>}
        </div>
      </section>
      <aside className="sidebar">
        <section className="tempo-panel">{speedPicker}<p>Променя паузите, а не силата на ботовете.</p></section>
        <section className="score-panel"><div className="panel-heading"><span>ПИШЕМ РЕЗУЛТАТА</span><span>ДО 151</span></div><div className="scores"><div><span>Ние</span><strong>{game.scores[0]}</strong><small>Ти & Борис</small></div><span className="score-separator">:</span><div><span>Те</span><strong>{game.scores[1]}</strong><small>Никола & Виктор</small></div></div>{game.hanging>0&&<p className="hanging">Висящи точки: {game.hanging}</p>}<div className="score-bottom"><span>{game.phase==='matchEnd'?'Край на мача':`Ръка ${Math.min(8,game.tricks.length+1)} / 8`}</span><button className="text-button" disabled={!last} onClick={()=>setModal('last')}>Последна ръка →</button></div></section>
        {latest&&ended&&<section className="result-panel"><div className="panel-heading">РАЗДАВАНЕ {latest.number}</div><h3>{latest.capot?'Валат!':latest.outcome==='made'?'Изпълнена обява':latest.outcome==='failed'?'Вътре':'Висяща игра'}</h3><div className="result-grid"><span/><b>Ние</b><b>Те</b><span>Карти и премии</span>{latest.cardPoints.map((n,i)=><span key={i}>{n}</span>)}<span>Анонси</span>{latest.declarationPoints.map((n,i)=><span key={i}>{n}</span>)}<span>Белот</span>{latest.belotPoints.map((n,i)=><span key={i}>{n}</span>)}<strong>Записваме</strong>{latest.added.map((n,i)=><strong key={i}>+{n}</strong>)}</div><DeclarationResults game={game}/>{latest.capot&&game.multiplier>1?<small>Валатът отменя контрата и реконтрата.</small>:latest.multiplier>1&&<small>Множител ×{latest.multiplier}</small>}</section>}
        <section className="table-log"><div className="panel-heading">КОЙ КАКВО ОБЯВИ <span>#{game.round}</span></div><ol ref={log} className="announcement-log" aria-label={`Обяви в раздаване ${game.round}`}>{events.length?events.map((e,i)=><li key={e.id} className={i===events.length-1?'latest':''} data-event-id={e.id}><span className="log-order">{String(i+1).padStart(2,'0')}</span><div><span>{NAMES[e.player]}</span><strong><EventText event={e}/></strong></div></li>):<li className="empty-log">Още няма обяви в това раздаване.</li>}</ol></section>
        {game.results.length>0&&<section className="history-panel"><div className="panel-heading">ЗАПИСАНИ РЪЦЕ</div>{game.results.slice(-5).map(r=><div className="history-row" key={r.number}><span>#{r.number} · {CONTRACT_LABEL[r.contract]}</span><b>+{r.added[0]} : +{r.added[1]}</b></div>)}</section>}
        <div className="table-options"><button onClick={()=>setModal('new')}>↻ Нова партия</button><button onClick={()=>setModal('rules')}>? Правила</button></div><label className="motion-setting"><input type="checkbox" checked={reduced} onChange={e=>setReduced(e.target.checked)}/>Намалено движение</label>
      </aside>
    </main>}
    <footer><span>Наклона · Същите маси. Различни истории.</span><div><i className={connected?'online-dot':'offline-dot'}/><span role="status">{connected?'Връзка с локалния сървър':'Свързване…'}</span><span className="footer-suits">♣ ♦ ♥ ♠</span></div></footer>
    <dialog ref={dialog} onCancel={()=>setModal(null)} onClick={e=>{if(e.target===dialog.current)setModal(null);}} aria-labelledby="dialog-title"><div className="dialog-content"><button className="dialog-close" onClick={()=>setModal(null)} aria-label="Затвори">×</button>
      {modal==='settings'&&<><span className="eyebrow">ТВОЯТА МАСА, ТВОИТЕ ПРАВИЛА</span><h2 id="dialog-title">Опции на играта</h2>{speedPicker}<label className="rule-setting"><input type="checkbox" checked={ruleDraft.allowContraEscape??settings.allowContraEscape} disabled={settingBusy||busy||!connected} aria-describedby="contra-escape-help" onChange={e=>void changeRule('allowContraEscape',e.target.checked)}/><strong>Бягане от контра</strong></label><p id="contra-escape-help">Позволява на обявилия и на партньора му да сменят контрирания договор с по-висока боя, „без коз“ или „всичко коз“. При изключена опция след контра може да се пасува или да се даде реконтра, без смяна на договора.</p><label className="rule-setting"><input type="checkbox" checked={ruleDraft.multiplyAnnouncements??settings.multiplyAnnouncements} disabled={settingBusy||busy||!connected} aria-describedby="announcement-multiplier-help" onChange={e=>void changeRule('multiplyAnnouncements',e.target.checked)}/><strong>Удвояване на анонсите при контра</strong></label><p id="announcement-multiplier-help">По подразбиране белотът, терцата, квартата (50), квинтата (100) и каретата се прибавят без умножение. При включена опция те се удвояват при контра и се учетворяват при реконтра. Валатът отменя множителя и в двата случая.</p><label className="rule-setting"><input type="checkbox" checked={ruleDraft.higherFourWins??settings.higherFourWins} disabled={settingBusy||busy||!connected} aria-describedby="higher-four-help" onChange={e=>void changeRule('higherFourWins',e.target.checked)}/><strong>По-високо каре печели</strong></label><p id="higher-four-help">Включено по подразбиране: отборът с по-високо каре отменя каретата на противника. Например каре попове отменя каре дами. При изключена опция се зачитат каретата и на двата отбора. Поредиците се сравняват отделно.</p><p>Промените се запазват автоматично и важат веднага, включително за ботовете.</p><button className="primary" onClick={()=>setModal(null)}>Готово</button></>}
      {modal==='rules'&&<><span className="eyebrow">ЕДНА ИГРА, МНОГО МАЙСТОРЛЪК</span><h2 id="dialog-title">Как се играе</h2><div className="rules-content"><p>Ти и Борис сте отбор срещу Никола и Виктор. Играете с 32 карти, обратно на часовниковата стрелка. Целта е 151 точки.</p><h3>Обявяване</h3><p>Първо получаваш 5 карти. Редът на обявите е ♣, ♦, ♥, ♠, без коз, всичко коз. Нова обява трябва да е по-висока. Следват още 3 карти, когато трима поред пасуват. Четири паса без обява водят до ново раздаване. Контрата удвоява, реконтрата учетворява. Реконтра може да даде всеки от отбора, който е обявил. Смяна на контриран договор е позволена само при включено „Бягане от контра“ в опциите; тогава по-високата обява отменя множителя и партньорът също може да смени договора.</p><h3>Разиграване</h3><p>Винаги отговаряш на боята. При игра на боя качваш задължително само в козовата боя. При всичко коз качваш във всяка поискана боя. Ако имаш по-висока карта от най-силната във взятката, трябва да я дадеш, включително над партньора. В останалите бои при игра на боя и на без коз не си длъжен да качваш. Ако нямаш от поисканата боя и съперник печели, цакаш или надцакваш, когато можеш. Ако партньорът печели или не можеш да надцакаш, можеш да чистиш. На без коз и всичко коз няма цакане на друга боя.</p><div className="rank-table"><span>Коз / всичко коз</span><b>J · 9 · A · 10 · K · Q · 8 · 7</b><span>Обикновена боя / без коз</span><b>A · 10 · K · Q · J · 9 · 8 · 7</b></div><h3>Анонси и белот</h3><p>Отбележи комбинациите преди първия си ход. Терца носи 20, четири поредни — 50, пет и повече — 100. Карета: валета 200, деветки 150, аса, десетки, попове и дами 100. Поредиците и каретата се сравняват отделно; при равенство съответният вид отпада. Една карта не може да участва едновременно в поредица и каре. Комбинациите се сравняват след първата ръка, а картите им се показват в края на раздаването.</p><p>Белот е K и Q от козова боя. Избери първата от двете карти и отметни „Обявявам белот“. На всичко коз белотът важи само при излизане или отговаряне на същата боя. На без коз няма анонси и белот.</p><h3>Резултат</h3><p>Последната ръка носи 10 точки, на без коз — 20. Валатът добавя 90. На без коз стойностите на картите са удвоени. Обявилият отбор трябва да събере повече сурови точки; иначе е вътре или точките висят. При контра точките от картите се умножават. Анонсите и белотът се прибавят без умножение, освен при включено „Удвояване на анонсите при контра“ в опциите. Победителят записва общия резултат. Валатът отменя контрата и реконтрата: например всичко коз с валат без анонси носи 35, а спечелена контрирана игра без валат — 52:0.</p><p>Точките се превръщат в запис чрез делене на 10. При коз се качва от остатък 7; при две шестици по-малкият сбор се качва. На всичко коз се качва от 5; при две четворки по-малкият сбор се качва. На без коз — от 6. При равенство на границата висящата страна се качва. Целият сбор за един отбор се закръгля от 5 нагоре. Висящите точки отиват при отбора, спечелил следващото решено раздаване.</p><p>Не се излиза с валат или висяща игра. При равен общ резултат играта продължава.</p><a href="https://belotarena.com/belot-rules" target="_blank" rel="noreferrer">Подробни правила ↗</a> · <a href="https://belotarena.com/belot-scoring" target="_blank" rel="noreferrer">Таблица за точкуване ↗</a></div></>}
      {modal==='about'&&<><span className="eyebrow">ДОБРЕ ДОШЪЛ В НАКЛОНА</span><h2 id="dialog-title">Любимата игра.<br/>Твоята маса.</h2><p>Български белот с трима компютърни играчи, които винаги имат време за още една ръка. Избери темпото и се настани удобно.</p><p>Лесните ботове играят непринудено. Средните помнят картите и подкрепят партньора. Трудните симулират възможни разпределения. Никой не вижда чуждите карти.</p><p>Партията се запазва автоматично на локалния сървър и се възстановява в същия браузър. За игра от телефон отвори адреса на компютъра в същата Wi-Fi мрежа.</p><label className="motion-setting"><input type="checkbox" checked={reduced} onChange={e=>setReduced(e.target.checked)}/>Намалено движение</label></>}
      {modal==='last'&&<><span className="eyebrow">ПОГЛЕД НАЗАД</span><h2 id="dialog-title">Последната ръка</h2>{last?<><p>Взема я {NAMES[last.winner]}.</p><div className="last-trick">{last.plays.map(p=><div key={p.player}><CardImage card={p.card}/><span>{NAMES[p.player]}</span>{p.player===last.winner&&<small>ПЕЧЕЛИ</small>}</div>)}</div></>:<p>Все още няма завършена ръка.</p>}</>}
      {modal==='new'&&<><span className="eyebrow">ОЩЕ ЕДНА ПАРТИЯ?</span><h2 id="dialog-title">Свежи карти.<br/>Нова история.</h2><p>{game?.phase==='matchEnd'?'Избери трудност за следващия мач.':'Новата партия ще замени текущата запазена игра.'}</p>{difficultyPicker}{speedPicker}<p className="difficulty-description">{difficultyText[difficulty]}</p><button className="primary" onClick={()=>void start()} disabled={busy||!connected}>Започни нова партия →</button></>}
    </div></dialog>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
if('serviceWorker' in navigator && import.meta.env.PROD)window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});});
