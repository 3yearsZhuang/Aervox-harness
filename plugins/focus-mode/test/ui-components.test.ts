// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { WORKBENCH_CONTEXT_KEY, type WorkbenchContext } from '@aervox/ui/plugin-api';
import FocusSettingsRow from '../src/ui/FocusSettingsRow.vue';
import FocusModeSwitch from '../src/ui/FocusModeSwitch.vue';
import FocusNavMenuItem from '../src/ui/FocusNavMenuItem.vue';
import FocusStudyCardActions from '../src/ui/FocusStudyCardActions.vue';
import FocusTaskCenterCard from '../src/ui/FocusTaskCenterCard.vue';
import { useFocusModeState } from '../src/ui/plugin-state';
import { openDailyProblem } from '../src/ui/daily-problem';

// CR-060 §B9b：每日一题入口已迁入插件包，组件不再经宿主 cards 调用
vi.mock('../src/ui/daily-problem', () => ({
  DAILY_PROBLEM_URL: 'https://example.test/daily',
  openDailyProblem: vi.fn(),
}));

/**
 * CR-060：插件 UI 组件测试随实现内聚于插件包。
 * 宿主包不再引用任何插件组件（`import-boundary` 规则 `host-no-plugin-implementation`）。
 */
function contextWith(extra: Record<string, unknown> = {}): WorkbenchContext {
  return { layout: {}, cards: {}, ...extra } as unknown as WorkbenchContext;
}

function mountWith(component: unknown, context: WorkbenchContext) {
  return mount(component as never, {
    global: { provide: { [WORKBENCH_CONTEXT_KEY as symbol]: context } },
  });
}

enableAutoUnmount(afterEach);

describe('plugins/focus-mode UI 组件', () => {
    it('shares the mode state between the header switch and settings row', async () => {
      const context = contextWith({ pluginRuntime: { isPluginAvailable: () => true } });
      const { focusModeEnabled } = useFocusModeState(context);
      focusModeEnabled.value = false;
      const header = mountWith(FocusModeSwitch, context);
      const settings = mountWith(FocusSettingsRow, context);
      expect(header.find('.study-switch-label').text()).toBe('专注模式');
      expect((settings.get('[role="switch"]').element as HTMLInputElement).checked).toBe(false);
      await header.get('[role="switch"]').setValue(true);
      expect(focusModeEnabled.value).toBe(true);
      expect((settings.get('[role="switch"]').element as HTMLInputElement).checked).toBe(true);
      await settings.get('[role="switch"]').setValue(false);
      expect(focusModeEnabled.value).toBe(false);
      expect((header.get('[role="switch"]').element as HTMLInputElement).checked).toBe(false);
    });

    it('keeps the settings switch unavailable when the plugin is disabled', () => {
      const settings = mountWith(FocusSettingsRow, contextWith({
        pluginRuntime: { isPluginAvailable: () => false },
      }));
      expect(settings.find('[role="switch"]').exists()).toBe(false);
    });
    it('FocusNavMenuItem.vue mounts, displays label, tooltip and handles active state & click action', async () => {

      const runMenuAction = vi.fn((action: () => void) => action());

      const mockContext = {

        layout: { runMenuAction },

      } as unknown as WorkbenchContext;

      const { learningOpen, activeLearningView } = useFocusModeState(mockContext);
      learningOpen.value = false;
      activeLearningView.value = 'study';

      const wrapper = mountWith(FocusNavMenuItem, mockContext);

      expect(wrapper.text()).toContain('学习能力');

      expect(wrapper.attributes('title')).toBe('学习能力');

      expect(wrapper.classes()).not.toContain('is-active');

      // Activate study drawer

      learningOpen.value = true;

      await wrapper.vm.$nextTick();

      expect(wrapper.classes()).toContain('is-active');

      // Switch to mistake view -> should not be active for study item

      activeLearningView.value = 'mistake';

      await wrapper.vm.$nextTick();

      expect(wrapper.classes()).not.toContain('is-active');

      // Trigger click：打开插件自有视图（宿主不再提供该 ToolId）

      await wrapper.trigger('click');

      expect(runMenuAction).toHaveBeenCalledTimes(1);

      expect(learningOpen.value).toBe(true);

      expect(activeLearningView.value).toBe('study');

    });

    it('FocusStudyCardActions.vue mounts and triggers operations on button clicks', async () => {

      const hostOpenDailyProblem = vi.fn();

      const openTool = vi.fn();

      const mockContext = {

        layout: { openTool },

        cards: { openDailyProblem: hostOpenDailyProblem },

      } as unknown as WorkbenchContext;

      const { focusModeEnabled, learningOpen, activeLearningView } = useFocusModeState(mockContext);
      focusModeEnabled.value = true;
      const wrapper = mountWith(FocusStudyCardActions, mockContext);

      const buttons = wrapper.findAll('button');

      expect(buttons.length).toBe(3);

      expect(buttons[0].text()).toContain('每日一题');

      expect(buttons[1].text()).toContain('开始专注');

      expect(buttons[2].text()).toContain('错题重练');

      await buttons[0].trigger('click');

      // 调用插件自有入口，且完全不再触碰宿主 cards 上的同名旧入口
      expect(vi.mocked(openDailyProblem)).toHaveBeenCalledTimes(1);
      expect(hostOpenDailyProblem).not.toHaveBeenCalled();

      await buttons[1].trigger('click');

      expect(openTool).toHaveBeenCalledWith('timer');

      await buttons[2].trigger('click');

      expect(learningOpen.value).toBe(true);

      expect(activeLearningView.value).toBe('mistake');

      // When focus mode is toggled off, action container is hidden

      focusModeEnabled.value = false;

      await wrapper.vm.$nextTick();

      expect(wrapper.find('.focus-study-card-actions').exists()).toBe(false);

      learningOpen.value = false;
      activeLearningView.value = 'study';

    });

    it('FocusTaskCenterCard.vue renders review tag and triggers navigation on button clicks', async () => {

      const taskCenterOpen = ref(true);

      const mockContext = {

        layout: { taskCenterOpen },

        cards: { syncReviewCount: ref(5) },

      } as unknown as WorkbenchContext;

      const { learningOpen, activeLearningView } = useFocusModeState(mockContext);
      learningOpen.value = false;

      activeLearningView.value = 'study';

      const wrapper = mountWith(FocusTaskCenterCard, mockContext);

      expect(wrapper.find('.focus-task-center-card').exists()).toBe(true);

      expect(wrapper.text()).toContain('间隔复习与错题排期');

      expect(wrapper.text()).toContain('5 个待复习');

      const buttons = wrapper.findAll('button');

      expect(buttons).toHaveLength(2);

      await buttons[0].trigger('click');

      expect(activeLearningView.value).toBe('mistake');

      expect(learningOpen.value).toBe(true);

      expect(taskCenterOpen.value).toBe(false);

      taskCenterOpen.value = true;

      learningOpen.value = false;

      await buttons[1].trigger('click');

      expect(activeLearningView.value).toBe('study');

      expect(learningOpen.value).toBe(true);

      expect(taskCenterOpen.value).toBe(false);

      learningOpen.value = false;

    });
});
