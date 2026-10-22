import {test,expect} from '@playwright/test';
import {newGame,view} from '../../src/game/engine';

test('game table logo is in the upper left after loading and reloading the production build',async({page},testInfo)=>{
  const state={game:view(newGame('medium')),settings:{speed:'normal',revision:0}};
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.route('**/api/events',route=>route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify(state)}\n\n`}));
  await page.goto('/');
  for(const reload of [false,true]){
    if(reload)await page.reload();
    const logo=page.locator('.game-table .table-brand');
    await expect(logo).toBeVisible();
    const table=(await page.locator('.game-table').boundingBox())!,bounds=(await logo.boundingBox())!;
    expect(bounds.x-table.x).toBeGreaterThan(0);
    expect(bounds.x-table.x).toBeLessThan(35);
    expect(bounds.y-table.y).toBeGreaterThan(0);
    expect(bounds.y-table.y).toBeLessThan(35);
  }
  await page.screenshot({path:`test-results/${testInfo.project.name}-logo-left.png`,fullPage:true});
});
