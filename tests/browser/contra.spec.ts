import {test,expect} from '@playwright/test';
import {newGame,applyAction,view} from '../../src/game/engine';

test('options modal saves escape before a game, persists on reload and applies immediately',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.getByRole('button',{name:'Опции на играта',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Опции на играта'})).toBeVisible();
 const option=dialog.getByRole('checkbox',{name:'Бягане от контра',exact:true});await expect(option).not.toBeChecked();
 await option.check();await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).settings.allowContraEscape).toBe(true);
 await dialog.getByRole('button',{name:'Готово',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await expect(option).toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await dialog.getByRole('button',{name:'Готово',exact:true}).click();
 await page.getByRole('button',{name:'Сядам на масата'}).click();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.allowContraEscape).toBe(true);
 await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await option.uncheck();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.allowContraEscape).toBe(false);
 await dialog.getByRole('button',{name:'Затвори',exact:true}).click();
 expect(errors).toEqual([]);
});

test('active contra offers recontra, locks upgrades, and settings immediately unlock higher contracts',async({page},testInfo)=>{
 const g=newGame('medium');applyAction(g,0,{type:'bid',bid:'D'});applyAction(g,1,{type:'bid',bid:'contra'});
 for(const p of [2,3])applyAction(g,p,{type:'bid',bid:'pass'});
 let settings={speed:'normal',allowContraEscape:false,revision:0};
 const state=()=>({game:view(g),settings});
 await page.addInitScript(()=>{
  class ConnectedSource {onopen:((e:Event)=>void)|null=null;constructor(){setTimeout(()=>this.onopen?.(new Event('open')),0);}close(){}}
  Object.defineProperty(window,'EventSource',{value:ConnectedSource});
 });
 await page.route('**/api/state',route=>route.fulfill({json:state()}));
 await page.route('**/api/settings',async route=>{
  const body=route.request().postDataJSON();settings={...settings,allowContraEscape:body.allowContraEscape,revision:settings.revision+1};
  g.allowContraEscape=body.allowContraEscape;g.revision++;await route.fulfill({json:state()});
 });
 await page.route('**/api/action',async route=>{applyAction(g,0,route.request().postDataJSON().action);await route.fulfill({json:state()});});
 await page.goto('/');await expect(page.getByRole('status')).toHaveText('Връзка с локалния сървър');
 await expect(page.getByRole('button',{name:'Реконтра',exact:true})).toBeEnabled();
 for(const name of ['Купа','Пика','Без коз','Всичко коз'])await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Опции на играта',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('checkbox',{name:'Бягане от контра',exact:true}).check();
 await expect.poll(()=>g.allowContraEscape).toBe(true);
 await page.screenshot({path:`test-results/${testInfo.project.name}-contra-options.png`,fullPage:true});
 await dialog.getByRole('button',{name:'Готово',exact:true}).click();
 for(const name of ['Купа','Пика','Без коз','Всичко коз'])await expect(page.getByRole('button',{name,exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await dialog.getByRole('checkbox',{name:'Бягане от контра',exact:true}).uncheck();
 await expect.poll(()=>g.allowContraEscape).toBe(false);await dialog.getByRole('button',{name:'Готово',exact:true}).click();
 await page.getByRole('button',{name:'Реконтра',exact:true}).click();
 await expect(page.getByTestId('contract')).toContainText('РЕКОНТРА ×4');
 expect(g.multiplier).toBe(4);
});


test('announcement option defaults off, persists and applies independently of contra escape',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Опции на играта',exact:true}).click();
 const dialog=page.getByRole('dialog'),option=dialog.getByRole('checkbox',{name:'Удвояване на анонсите при контра',exact:true});
 await expect(option).not.toBeChecked();await option.check();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).settings.multiplyAnnouncements).toBe(true);
 await page.reload();await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await expect(option).toBeChecked();
 await expect(dialog.getByRole('checkbox',{name:'Бягане от контра',exact:true})).not.toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await dialog.getByRole('button',{name:'Готово',exact:true}).click();await page.getByRole('button',{name:'Сядам на масата'}).click();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.multiplyAnnouncements).toBe(true);
 await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await option.uncheck();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.multiplyAnnouncements).toBe(false);
});


test('higher four option starts checked, saves independently and applies to the current game',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Опции на играта',exact:true}).click();
 const dialog=page.getByRole('dialog'),option=dialog.getByRole('checkbox',{name:'По-високо каре печели',exact:true});
 await expect(option).toBeChecked();await option.uncheck();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).settings.higherFourWins).toBe(false);
 await page.reload();await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await expect(option).not.toBeChecked();
 await expect(dialog.getByRole('checkbox',{name:'Удвояване на анонсите при контра',exact:true})).not.toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await dialog.getByRole('button',{name:'Готово',exact:true}).click();await page.getByRole('button',{name:'Сядам на масата'}).click();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.higherFourWins).toBe(false);
 await page.getByRole('button',{name:'Опции на играта',exact:true}).click();await option.check();
 await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).game.higherFourWins).toBe(true);
});
