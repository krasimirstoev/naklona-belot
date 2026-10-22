import {test,expect} from '@playwright/test';
import type {View} from '../../src/game/types';
import {newGame,applyAction,view as publicView} from '../../src/game/engine';

test('lobby, cards, responsive table, full round, restore and last trick',async({page},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.getByRole('button',{name:'Сядам на масата'})).toBeEnabled();
  await expect(page.locator('.brand-logo')).toBeVisible();
  await expect(page.locator('.preview-table .table-brand')).toBeVisible();
  await page.screenshot({path:`test-results/${testInfo.project.name}-lobby.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('img').evaluateAll(images=>images.every(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0))).toBe(true);
  await page.getByRole('button',{name:'Сядам на масата'}).click();
  await expect(page.getByRole('heading',{name:'Една добра ръка.'})).toBeVisible();
  await page.getByRole('button',{name:'Всичко коз',exact:true}).click();
  await expect(page.getByTestId('play-status')).toBeVisible({timeout:12000});
  await expect(page.locator('.game-table .table-brand')).toBeVisible();
  await page.screenshot({path:`test-results/${testInfo.project.name}-table.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(testInfo.project.name==='desktop'){const box=(await page.locator('.game-table').boundingBox())!;expect(box.width*box.height).toBeGreaterThan(1006*346*1.3);}
  const state=async():Promise<View>=>(await(await page.request.get('/api/state')).json()).game;
  // Play human moves through the actual UI while bots use the server's scheduler.
  let moves=0;
  while(true){
    const g=await state();if(['roundEnd','matchEnd'].includes(g.phase))break;
    if(g.turn===0&&g.phase==='bidding')await page.getByRole('button',{name:'Пас',exact:true}).click();
    else if(g.turn===0&&g.phase==='playing'){
      const card=g.legalCards[0];const button=page.locator('.hand-card').filter({has:page.locator(`img[src="/cards/${card}.svg"]`)});
      await button.dblclick();moves++;
    }
    await page.waitForTimeout(60);
  }
  expect(moves).toBe(8);
  await expect(page.getByRole('button',{name:'Следващо раздаване'})).toBeVisible();
  const before=await state();await page.reload();await expect(page.getByRole('button',{name:'Следващо раздаване'})).toBeVisible();expect((await state()).revision).toBe(before.revision);
  await page.getByRole('button',{name:'Последна ръка'}).click();await expect(page.getByRole('heading',{name:'Последната ръка'})).toBeVisible();await expect(page.locator('.last-trick img')).toHaveCount(4);
  await page.getByRole('button',{name:'Затвори',exact:true}).click();await page.getByRole('button',{name:'Следващо раздаване'}).click();
  await expect.poll(async()=>(await state()).round).toBe(2);
  expect(errors).toEqual([]);
});

test('hard worker advances, SSE reconnects, rules and settings work',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'Трудна',exact:true}).click();await page.getByRole('button',{name:'Сядам на масата'}).click();
  await page.getByRole('button',{name:'Всичко коз',exact:true}).click();
  await expect(page.getByTestId('play-status')).toBeVisible({timeout:15000});
  const g:View=(await(await page.request.get('/api/state')).json()).game;
  expect(g.difficulty).toBe('hard');expect(g.revision).toBeGreaterThanOrEqual(4);
  const card=g.legalCards[0];await page.locator('.hand-card').filter({has:page.locator(`img[src="/cards/${card}.svg"]`)}).dblclick();
  await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.revision,{timeout:15000}).toBeGreaterThanOrEqual(g.revision+4);
  await page.context().setOffline(true);await expect(page.getByRole('status')).toHaveText('Свързване…');await page.context().setOffline(false);
  await expect(page.getByText('Връзка с локалния сървър',{exact:true})).toBeVisible({timeout:15000});
  await page.getByRole('button',{name:'Как се играе',exact:true}).click();await expect(page.getByRole('heading',{name:'Как се играе',exact:true})).toBeVisible();await page.getByRole('button',{name:'Затвори',exact:true}).click();
  await page.getByLabel('Намалено движение').check();await expect(page.locator('html')).toHaveAttribute('data-reduced','true');
  expect(errors).toEqual([]);
});

test('complete browser match reaches 151 and offers a new match',async({page},testInfo)=>{
  test.skip(testInfo.project.name==='phone','Full round and touch interactions are covered separately on phone.');
  test.setTimeout(120000);
  await page.goto('/');await page.getByRole('button',{name:'Сядам на масата'}).click();
  let steps=0;
  while(steps++<2000){
    const g:View=(await(await page.request.get('/api/state')).json()).game;
    if(g.phase==='matchEnd'){
      expect(Math.max(...g.scores)).toBeGreaterThanOrEqual(151);
      await expect(page.getByRole('button',{name:'Нова партия →',exact:true})).toBeVisible();
      await page.screenshot({path:'test-results/desktop-match-end.png',fullPage:true});return;
    }
    if(g.phase==='roundEnd')await page.getByRole('button',{name:'Следващо раздаване'}).click();
    else if(g.turn===0&&g.phase==='bidding'){
      // Always establish a contract on the first call, pass when bots have bid.
      await page.getByRole('button',{name:g.contract?'Пас':'Всичко коз',exact:true}).click();
    }else if(g.turn===0&&g.phase==='playing'){
      const c=g.legalCards[0];await page.locator('.hand-card').filter({has:page.locator(`img[src="/cards/${c}.svg"]`)}).dblclick();
    }
    await page.waitForTimeout(25);
  }
  throw new Error('Match did not terminate.');
});

test('PWA caches the built interface and cards for offline opening',async({page})=>{
  await page.goto('/');await expect(page.getByRole('button',{name:'Сядам на масата'})).toBeEnabled();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(async()=>page.evaluate(async()=>{const keys=await caches.keys();const cache=await caches.open(keys.find(k=>k.startsWith('naklona-'))!);return (await cache.keys()).some(r=>/assets\/index-.*\.js$/.test(new URL(r.url).pathname));})).toBe(true);
  expect(await page.evaluate(async()=>{const keys=await caches.keys();const cache=await caches.open(keys.find(k=>k.startsWith('naklona-'))!);return Promise.all(['/assets/bar-v2.webp','/assets/table-top.webp','/assets/back-v2.webp','/cards/back.svg','/assets/naklona-mark.svg','/assets/naklona-carved.svg','/assets/naklona-logo.png'].map(async url=>!!await cache.match(url)));})).toEqual([true,true,true,true,true,true,true]);
  await page.context().setOffline(true);await page.reload();
  await expect(page.getByRole('heading',{name:/Добрата игра/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Сядам на масата'})).toBeDisabled();
  await page.context().setOffline(false);await expect(page.getByRole('button',{name:'Сядам на масата'})).toBeEnabled({timeout:15000});
});

test('narrow phone and landscape keep controls inside the viewport',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Mobile viewport matrix.');
  await page.setViewportSize({width:350,height:740});await page.goto('/');
  await expect(page.getByRole('button',{name:'Сядам на масата'})).toBeEnabled();
  await page.getByRole('button',{name:'Включи звука'}).click();await expect(page.getByRole('button',{name:'Изключи звука'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Сядам на масата'}).click();await page.getByRole('button',{name:'Всичко коз',exact:true}).click();
  await expect(page.getByTestId('play-status')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:844,height:390});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByTestId('play-status')).toBeVisible();
});

test('speed persists, single clicks leave cards unchanged, and public announcements remain readable after reload',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Бавна',exact:true}).click();
  await expect(page.getByRole('button',{name:'Бавна',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Сядам на масата'}).click();
  await expect(page.locator('.player-call')).toHaveCount(4);
  await expect(page.locator('.not-called')).toHaveCount(4);
  await page.getByRole('button',{name:'Всичко коз',exact:true}).click();
  await expect(page.getByTestId('play-status')).toBeVisible();
  const before:View=(await(await page.request.get('/api/state')).json()).game;
  const card=page.locator('.hand-card').filter({has:page.locator(`img[src="/cards/${before.legalCards[0]}.svg"]`)});
  await card.click();await page.getByRole('button',{name:'Бърза',exact:true}).click();
  await expect(page.getByRole('button',{name:'Бърза',exact:true})).toHaveAttribute('aria-pressed','true');await expect(card).not.toHaveAttribute('aria-pressed');
  expect((await(await page.request.get('/api/state')).json()).game.revision).toBe(before.revision);
  await expect(page.locator('[data-player="0"]')).toContainText('Всичко коз');
  await expect(page.getByTestId('contract')).toContainText('Обявил: Ти');
  await expect(page.locator('.announcement-log li')).toHaveCount(4);
  const eventIds=await page.locator('.announcement-log li').evaluateAll(items=>items.map(i=>i.getAttribute('data-event-id')));
  await page.reload();await expect(page.getByRole('button',{name:'Бърза',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.announcement-log li')).toHaveCount(4);
  expect(await page.locator('.announcement-log li').evaluateAll(items=>items.map(i=>i.getAttribute('data-event-id')))).toEqual(eventIds);
  await expect(page.getByTestId('announcement-live')).toHaveText('');
  for(const p of [1,2,3])await expect(page.locator(`[data-player="${p}"]`)).toContainText('Пас');
});


test('four played cards and several announcements do not overlap player labels',async({page},testInfo)=>{
  const g=newGame('medium');applyAction(g,0,{type:'bid',bid:'H'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  g.hands=[['C-7','C-8','C-9','H-J','H-Q','H-K','D-7','S-8'],['C-10','C-J','C-Q','C-K','D-8','D-9','S-7','S-9'],['D-10','D-J','D-Q','D-K','H-7','H-8','H-9','H-10'],['C-A','D-A','H-A','S-10','S-J','S-Q','S-K','S-A']];
  applyAction(g,0,{type:'play',card:'H-K',declare:publicView(g).declarations.map(d=>d.id),belot:true});
  applyAction(g,1,{type:'play',card:'C-10',declare:publicView(g,1).declarations.map(d=>d.id)});
  applyAction(g,2,{type:'play',card:'H-10'});
  applyAction(g,3,{type:'play',card:'H-A'});
  const state={game:publicView(g),settings:{speed:'normal',revision:0}};
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.route('**/api/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify(state)}\n\n`}));
  await page.goto('/');await expect(page.locator('.played-card')).toHaveCount(4);
  expect(await page.locator('.announcement-log').evaluate(e=>e.scrollTop+e.clientHeight>=e.scrollHeight-1)).toBe(true);
  await expect(page.locator('[data-player="0"]')).toContainText('Терца');await expect(page.locator('[data-player="0"]')).toContainText('Белот');
  const measure=()=>page.evaluate(()=>{
    const labels=[...document.querySelectorAll('.player-info,.player-call,.your-player')];
    return [...document.querySelectorAll('.played-card')].flatMap(card=>{const a=card.getBoundingClientRect();return labels.flatMap(label=>{const b=label.getBoundingClientRect();return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1?[{card:card.className,label:label.className,player:label.getAttribute('data-player'),cardBounds:{x:a.x,y:a.y,w:a.width,h:a.height},labelBounds:{x:b.x,y:b.y,w:b.width,h:b.height}}]:[];});});
  });
  await page.screenshot({path:`test-results/${testInfo.project.name}-four-cards.png`,fullPage:true});
  expect(await measure()).toEqual([]);
  if(testInfo.project.name==='phone')for(const size of [{width:350,height:740},{width:844,height:390}]) {
    await page.setViewportSize(size);expect(await measure()).toEqual([]);
    await page.screenshot({path:`test-results/phone-${size.width}-four-cards.png`,fullPage:true});
  }
});

test('double touch on phone and keyboard activation on desktop submit one card without a play button',async({page},testInfo)=>{
  const plays:unknown[]=[];page.on('request',r=>{if(r.url().endsWith('/api/action')&&r.method()==='POST'){const body=r.postDataJSON();if(body.action.type==='play')plays.push(body);}});
  await page.goto('/');await page.getByRole('button',{name:'Сядам на масата'}).click();await page.getByRole('button',{name:'Всичко коз',exact:true}).click();
  await expect(page.getByTestId('play-status')).toBeVisible();await expect(page.getByRole('button',{name:'Играй картата'})).toHaveCount(0);
  const before:View=(await(await page.request.get('/api/state')).json()).game;
  const card=page.locator('.hand-card').filter({has:page.locator(`img[src="/cards/${before.legalCards[0]}.svg"]`)});
  if(testInfo.project.name==='phone'){
    await card.tap();expect(plays).toHaveLength(0);await card.tap();
  }else{
    await card.click();expect(plays).toHaveLength(0);await card.press('Enter');
  }
  await expect.poll(()=>plays.length).toBe(1);
  await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.revision).toBeGreaterThan(before.revision);
  expect(plays).toHaveLength(1);
});

test('double click keeps manual announcements and belot, and refuses illegal cards',async({page})=>{
  const g=newGame('medium');applyAction(g,0,{type:'bid',bid:'H'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  g.hands[0]=['C-7','C-8','C-9','H-J','H-Q','H-K','D-7','S-8'];g.trick=[{player:3,card:'H-7'}];g.turn=0;
  const state=()=>({game:publicView(g),settings:{speed:'normal',revision:0}});
  await page.addInitScript(()=>{
    class ConnectedSource {
      onopen:((e:Event)=>void)|null=null;
      constructor(){setTimeout(()=>this.onopen?.(new Event('open')),0);}
      close(){}
    }
    Object.defineProperty(window,'EventSource',{value:ConnectedSource});
  });
  await page.route('**/api/state',route=>route.fulfill({json:state()}));
  const requests:Record<string,unknown>[]=[];
  await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();requests.push(body.action);applyAction(g,0,body.action);await route.fulfill({json:state()});});
  await page.goto('/');await expect(page.getByRole('status')).toHaveText('Връзка с локалния сървър');
  const king=page.locator('.hand-card').filter({has:page.locator('img[src="/cards/H-K.svg"]')});
  await king.click();expect(requests).toHaveLength(0);await expect(king).not.toHaveAttribute('aria-pressed');
  await page.locator('.hand-card').filter({has:page.locator('img[src="/cards/C-7.svg"]')}).dblclick({force:true});
  await expect(page.getByRole('alert')).toContainText('Тази карта не е допустима');expect(requests).toHaveLength(0);
  for(const checkbox of await page.locator('.announcements input').all())await checkbox.check();
  await page.getByLabel('Обявявам белот').check();await king.dblclick();
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0]).toMatchObject({type:'play',card:'H-K',belot:true});expect(requests[0].declare).toHaveLength(2);
  expect(g.hands[0]).not.toContain('H-K');expect(g.announcements).toHaveLength(2);expect(g.belots).toHaveLength(1);
});
