import {test,expect} from '@playwright/test';
import {applyAction,deck,newGame,view} from '../../src/game/engine';
import {SUITS} from '../../src/game/types';

test('all-trump capot cancels the auction double in the displayed result and contract strip',async({page},testInfo)=>{
 const g=newGame('medium'),hands=SUITS.map(s=>deck().filter(c=>c.startsWith(`${s}-`)));
 g.hands=hands.map(h=>h.slice(0,5));g.stock=hands.flatMap(h=>h.slice(5));
 applyAction(g,0,{type:'bid',bid:'AT'});applyAction(g,1,{type:'bid',bid:'contra'});
 for(const p of [2,3,0])applyAction(g,p,{type:'bid',bid:'pass'});
 while(g.phase==='playing'||g.phase==='trick'){
  if(g.phase==='trick')applyAction(g,-1,{type:'collect'});
  else applyAction(g,g.turn,{type:'play',card:view(g,g.turn).legalCards[0]});
 }
 expect(g.multiplier).toBe(2);expect(g.results[0].multiplier).toBe(1);expect(g.results[0].added).toEqual([35,0]);
 const state={game:view(g),settings:{speed:'normal',allowContraEscape:false,multiplyAnnouncements:false,higherFourWins:true,revision:0}};
 await page.route('**/api/state',route=>route.fulfill({json:state}));
 await page.route('**/api/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify(state)}\n\n`}));
 await page.goto('/');await expect(page.getByRole('heading',{name:'Валат!',exact:true})).toBeVisible();
 await expect(page.locator('.result-panel')).toContainText('Валатът отменя контрата и реконтрата.');
 await expect(page.locator('.result-panel').getByText('+35',{exact:true})).toBeVisible();
 await expect(page.locator('.result-panel')).not.toContainText('Множител ×2');
 await expect(page.getByTestId('contract')).not.toContainText('КОНТРА ×2');
 await expect(page.getByRole('button',{name:'Следващо раздаване'})).toBeVisible();
 await page.screenshot({path:`test-results/${testInfo.project.name}-capot-cancels-contra.png`,fullPage:true});
});
