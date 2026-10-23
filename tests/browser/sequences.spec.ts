import {test,expect} from '@playwright/test';
import {calculateResult,declarations,newGame,view} from '../../src/game/engine';
import type {Card} from '../../src/game/types';
const sequence=(cards:Card[],player:number)=>({...declarations(cards,'AT')[0],player});

test('round end reveals sequence tops, owners, cards and the declarations retained by the winning team',async({page})=>{
 const g=newGame('medium');g.contract='AT';g.declarer=0;g.phase='roundEnd';
 g.tricks=[{winner:0,plays:[{player:0,card:'C-J'}]},{winner:1,plays:[]}];
 g.announcements=[sequence(['H-7','H-8','H-9','H-10'],0),sequence(['S-7','S-8','S-9'],2),sequence(['D-Q','D-K','D-A'],1)];
 g.results=[calculateResult(g)];g.scores=g.results[0].total;
 const state=()=>({game:view(g),settings:{speed:'normal',allowContraEscape:false,multiplyAnnouncements:false,higherFourWins:true,revision:0}});
 await page.route('**/api/state',route=>route.fulfill({json:state()}));
 await page.route('**/api/events',route=>route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify(state())}\n\n`}));
 await page.goto('/');const panel=page.getByTestId('declaration-results');
 await expect(panel).toBeVisible();
 const own=panel.getByRole('listitem').filter({hasText:'Ти · Ние'}),partner=panel.getByRole('listitem').filter({hasText:'Борис · Ние'}),opponent=panel.getByRole('listitem').filter({hasText:'Никола · Те'});
 await expect(own).toContainText('Кварта до десетка');await expect(own).toContainText('7♥ · 8♥ · 9♥ · 10♥');await expect(own).toContainText('Зачита се: +50');
 await expect(partner).toContainText('Терца до деветка');await expect(partner).toContainText('Зачита се: +20');
 await expect(opponent).toContainText('Терца до асо');await expect(opponent).toContainText('Отпада: противникът има по-силна поредица');
 expect(g.results[0].declarationPoints).toEqual([70,0]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 g.phase='matchEnd';g.announcements=[sequence(['C-10','C-J','C-Q'],0),sequence(['D-Q','D-K','D-A'],1)];g.results=[calculateResult(g)];
 await page.reload();await expect(panel).toBeVisible();
 await expect(panel.getByRole('listitem').filter({hasText:'Терца до дама'})).toHaveAttribute('data-status','beaten');
 await expect(panel.getByRole('listitem').filter({hasText:'Терца до асо'})).toHaveAttribute('data-status','counted');
});
