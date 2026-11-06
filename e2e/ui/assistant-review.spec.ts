import { test, expect } from './fixtures';

test('opens due knowledge, preserves an uncertain self-assessment and reads its next date after reload', async ({ page, servers, platform }) => {
  await page.setViewportSize(platform === 'mobile' ? {width: 390, height: 844} : {width: 1280, height: 800});
  await page.emulateMedia({reducedMotion: 'reduce'});
  const review = {id: 'review_browser', knowledgeId: 'knowledge_browser', dueAt: '2020-01-01T12:00:00.000Z',
    intervalDays: 1, schedulerVersion: 2, timezoneSnapshot: 'Asia/Shanghai', status: 'active'};
  const knowledge = {id: review.knowledgeId, concept: '先回想二次方程的求根公式，再核对判别式。', sourceStatus: 'observed',
    masteryState: 'reviewing', correctCount: 0, wrongCount: 0, correctStreak: 0, mastery: 0,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z'};
  const completed = {...review, status: 'completed', completionIsCorrect: false, nextReviewId: 'review_next_browser', updatedAt: '2026-11-07T00:00:00.000Z'};
  const nextReview = {...review, id: completed.nextReviewId, dueAt: '2027-01-02T12:00:00.000Z', intervalDays: 2};
  const submissions: unknown[] = [];
  let accepted = false;
  await page.route('**/v1/review-items**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') { await route.continue(); return; }
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      submissions.push(request.postDataJSON());
      if (!accepted) { accepted = true; await route.abort('failed'); return; }
    }
    const items = accepted ? [] : [review];
    const body = request.method() === 'POST' ? {completed, nextReview, knowledge}
      : url.pathname.endsWith('/summary') ? {items, dueCount: items.length, overdueCount: items.length, dueTodayCount: 0,
        estimatedMinutes: items.length * 2, timeZone: url.searchParams.get('timeZone')}
      : url.pathname.endsWith('/history') ? {items: accepted ? [{...completed, nextReview}] : []} : {items};
    await route.fulfill({headers: {'Access-Control-Allow-Origin': '*'}, contentType: 'application/json', body: JSON.stringify(body)});
  });
  await page.route(`**/v1/knowledge-items/${review.knowledgeId}`, route => route.fulfill({headers: {'Access-Control-Allow-Origin': '*'},
    contentType: 'application/json', body: JSON.stringify({...knowledge, wrongCount: accepted ? 1 : 0,
      updatedAt: accepted ? completed.updatedAt : knowledge.updatedAt})}));
  for (const [path, body] of [['mistakes?status=all', {items: []}], ['learning-plans', {items: []}],
    ['practice/sessions/active', null]] as const) {
    await page.route(`**/v1/${path}`, route => route.fulfill({headers: {'Access-Control-Allow-Origin': '*'},
      contentType: 'application/json', body: JSON.stringify(body)}));
  }
  const openReviews = async () => {
    await page.getByRole('navigation', {name: '首页入口'}).getByRole('button', {name: /^今日/}).click();
    const today = platform === 'mobile' ? page.locator('md-dialog[data-aria-label="今日"]')
      : page.getByRole('dialog', {name: '今日', exact: true});
    await expect(today).toBeVisible();
    await expect(page.getByRole('dialog', {name: '今日', exact: true})).toBeVisible();
    await today.getByRole('button', {name: '今日复习', exact: true}).click();
    const learning = platform === 'mobile' ? page.locator('md-dialog[data-aria-label="学习能力"]')
      : page.getByRole('dialog', {name: '学习能力', exact: true});
    await expect(learning).toBeVisible();
    await expect(page.getByRole('dialog', {name: '学习能力', exact: true})).toBeVisible();
    return page.locator('.review-learning-view');
  };
  await page.goto(`${servers.webUrl}/?surface=proactive-ui`);
  const panel = await openReviews();
  await expect(panel).toContainText('1 项已到期');
  await panel.getByRole('button', {name: '打开知识内容', exact: true}).click();
  await expect(panel).toContainText(knowledge.concept);
  await panel.getByRole('button', {name: '还需复习', exact: true}).click();
  await expect(panel).toContainText('本次自评结果尚未确认');
  await panel.getByRole('button', {name: '刷新复习记录', exact: true}).click();
  await expect(panel.getByRole('button', {name: '重试原自评', exact: true})).toBeEnabled();
  await panel.getByRole('button', {name: '重试原自评', exact: true}).click();
  await expect(panel).toContainText('自评已保存');
  await expect(panel).toContainText('本次自评：还需复习');
  await expect(panel).toContainText('2027');
  await expect(panel).toContainText('调度 v2');
  await expect(page.getByText('部分学习记录暂时不可用，请刷新重试。', {exact: true})).not.toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(submissions[0]).toMatchObject({isCorrect: false, timeZone: expect.any(String)});
  await page.screenshot({path: `/tmp/aervox-review-loop-${platform}.png`});
  await page.reload();
  const reopened = await openReviews();
  await expect(reopened).toContainText('最近复习记录');
  await expect(reopened).toContainText('自评还需复习');
  await expect(reopened).toContainText('2027');
  expect(submissions).toHaveLength(2);
});
