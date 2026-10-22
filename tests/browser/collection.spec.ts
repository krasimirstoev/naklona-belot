import {test,expect} from '@playwright/test';
import {newGame,view} from '../../src/game/engine';
import type {StateResponse,View} from '../../src/game/types';

async function mockTable(page:import('@playwright/test').Page,reduced=false){
  const game:View={...view(newGame('medium')),phase:'trick',contract:'H',trick:[
    {player:0,card:'H-A'},{player:1,card:'H-7'},{player:2,card:'H-8'},{player:3,card:'H-9'}
  ]};
  const state=(game:View):StateResponse=>({game,settings:{speed:'fast',revision:0}});
  if(reduced)await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(()=>{
    class Source {
      onopen:((e:Event)=>void)|null=null;
      onmessage:((e:MessageEvent)=>void)|null=null;
      listener=(e:Event)=>this.onmessage?.(new MessageEvent('message',{data:JSON.stringify((e as MessageEvent).data)}));
      constructor(){window.addEventListener('table-state',this.listener);setTimeout(()=>this.onopen?.(new Event('open')),0);}
      close(){window.removeEventListener('table-state',this.listener);}
    }
    Object.defineProperty(window,'EventSource',{value:Source});
  });
  await page.route('**/api/state',route=>route.fulfill({json:state(game)}));
  await page.goto('/');
  await expect(page.locator('.trick-area > .played-card')).toHaveCount(4);
  return {game,emit:async(game:View)=>page.evaluate(data=>window.dispatchEvent(new MessageEvent('table-state',{data})),state(game))};
}

test('collected cards travel to each winner, including the last trick',async({page})=>{
  const {game,emit}=await mockTable(page);
  for(const winner of [0,1,2,3]){
    // Each winner has the ace; other cards follow suit.
    const trick=game.trick.map(p=>({...p,card:(['H-A','H-7','H-8','H-9'] as const)[(p.player+4-winner)%4]}));
    const before={...game,revision:winner*2+1,trick,tricks:Array(winner===3?7:winner).fill({plays:trick,winner})};
    await emit(before);await expect(page.locator('.trick-area > .played-card')).toHaveCount(4);
    const after:View={...before,revision:before.revision+1,phase:winner===3?'roundEnd':'playing',tricks:[...before.tricks,{plays:trick,winner}],trick:winner===3?[]:[{player:winner,card:'C-7'}]};
    const result=await page.evaluate(async data=>{
      window.dispatchEvent(new MessageEvent('table-state',{data}));
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const layer=document.querySelector('.collecting-trick')!;
      const animations=layer.getAnimations({subtree:true});
      animations.forEach(a=>{a.pause();a.currentTime=459;});
      const winner=Number(layer.getAttribute('data-winner'));
      const target=document.querySelector(winner===0?'.your-player':`.player-${winner} .player-info`)!.getBoundingClientRect();
      const distances=Array.from(layer.children,card=>{
        const bounds=card.getBoundingClientRect();
        return Math.hypot(bounds.x+bounds.width/2-target.x-target.width/2,bounds.y+bounds.height/2-target.y-target.height/2);
      });
      return {winner,count:animations.length,distances};
    },{game:after,settings:{speed:'fast',revision:0}});
    expect(result.winner).toBe(winner);expect(result.count).toBe(4);
    expect(result.distances.every(d=>d<3)).toBe(true);
    await page.evaluate(()=>document.querySelector('.collecting-trick')!.getAnimations({subtree:true}).forEach(a=>a.play()));
    await expect(page.locator('.collecting-trick')).toHaveCount(0);
    await expect(page.locator('.trick-area > .played-card')).toHaveCount(after.trick.length);
  }
});

test('reduced motion skips collection and reload does not replay it',async({page})=>{
  const {game,emit}=await mockTable(page,true);
  const collected:View={...game,revision:1,phase:'playing',trick:[],tricks:[{plays:game.trick,winner:0}]};
  await emit(collected);
  await expect(page.locator('.trick-area > .played-card')).toHaveCount(0);
  await expect(page.locator('.collecting-trick')).toHaveCount(0);
  await page.route('**/api/state',route=>route.fulfill({json:{game:collected,settings:{speed:'fast',revision:0}}}));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>localStorage.setItem('reduced','false'));
  await page.reload();
  await expect(page.locator('.lead-hint')).toBeVisible();
  await expect(page.locator('.collecting-trick')).toHaveCount(0);
});
