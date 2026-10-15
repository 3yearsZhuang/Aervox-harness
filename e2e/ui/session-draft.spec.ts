/**
 * Aervox｜思隅 UI E2E — 跨会话草稿保留
 *
 * 回归：移动端平台（VITE_AERVOX_PLATFORM=mobile，useWorkbenchComposer 的
 * draftsEnabled=layout.isMobile）下，在 composer 输入草稿不发送，切换到另一个
 * 会话再切回，草稿仍在（localStorage 键 aervox-mobile-draft:<sessionId>）。
 *
 * 会话通过 API（POST /v1/sessions）预建；本测试不发送任何消息，不触发 LLM。
 */
import { test, expect, openWorkbench } from "./fixtures";

const DRAFT_TEXT = "这是一条未发送的草稿";

test.describe("跨会话草稿保留", () => {
  test("会话 A 输入草稿 → 切到 B → 切回 A，草稿仍在", async ({
    page,
    request,
    servers,
  }) => {
    // 用 API 预建两个会话（CR-030 后 API 使用固定本地上下文，Header 可选）
    const createSession = async (title: string): Promise<{ id: string }> => {
      const res = await request.post(servers.apiUrl + "/v1/sessions", {
        data: { title },
      });
      expect(res.status()).toBe(201);
      return (await res.json()) as { id: string };
    };
    const sessionA = await createSession("草稿会话甲");
    const sessionB = await createSession("草稿会话乙");

    // 让工作台启动时即以会话 A 为活跃会话
    await page.addInitScript((id: string) => {
      window.localStorage.setItem("aervox_active_session_id", id);
    }, sessionA.id);

    await openWorkbench(page, servers.webUrl);

    const composer = page.locator("#aervox-composer");
    await expect(composer).toBeVisible();
    // 等待会话数据加载且当前会话为 A
    await expect(page.locator(".session-active-title")).toHaveText(
      "草稿会话甲",
    );

    // 输入草稿但不发送，等待草稿 watcher 写入 localStorage
    await composer.fill(DRAFT_TEXT);
    await expect
      .poll(
        () =>
          page.evaluate(
            (sid: string) =>
              window.localStorage.getItem(
                "aervox-mobile-draft:" + encodeURIComponent(sid),
              ),
            sessionA.id,
          ),
      )
      .toBe(DRAFT_TEXT);

    // 切换到会话 B（经侧栏抽屉的真实 UI 路径）
    await page.getByRole("button", { name: "展开侧边栏" }).click();
    await page
      .getByRole("button", { name: "草稿会话乙", exact: true })
      .click();
    await expect(page.locator(".session-active-title")).toHaveText(
      "草稿会话乙",
    );
    await expect(composer).toHaveValue("");

    // 切回会话 A，草稿恢复
    await page.getByRole("button", { name: "展开侧边栏" }).click();
    await page
      .getByRole("button", { name: "草稿会话甲", exact: true })
      .click();
    await expect(page.locator(".session-active-title")).toHaveText(
      "草稿会话甲",
    );
    await expect(composer).toHaveValue(DRAFT_TEXT);
  });
});
