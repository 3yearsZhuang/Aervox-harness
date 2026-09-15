import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import CommandPalette from '../src/components/workbench/CommandPalette.vue';
import { WORKBENCH_CONTEXT_KEY, type WorkbenchContext } from '../src/composables/workbench-context';

describe('CommandPalette.vue (CR-048 / W3)', () => {
  it('renders actions, projects, and sessions, and handles search and selection', async () => {
    const createNewSession = vi.fn();
    const switchSession = vi.fn();
    const selectProject = vi.fn();
    const fetchSessions = vi.fn();
    const openProjectManager = vi.fn();
    const openImportSession = vi.fn();

    const mockProjects = ref([
      { id: 'proj_algo', name: '算法导论', description: '数据结构与算法', color: '#10b981', createdAt: '', updatedAt: '' },
    ]);
    const mockSessions = ref([
      { id: 'ses_dp', title: '动态规划专题讨论', createdAt: '', updatedAt: '2026-09-14T10:00:00Z' },
    ]);

    const mockContext = {
      layout: {
        isDark: ref(true),
        toggleTheme: vi.fn(),
        openSettings: vi.fn(),
      },
      sessions: {
        sessions: mockSessions,
        createNewSession,
        switchSession,
        fetchSessions,
      },
      projects: {
        projects: mockProjects,
        selectedProjectId: ref(null),
        selectProject,
      },
      openProjectManager,
      openImportSession,
    } as unknown as WorkbenchContext;

    const wrapper = mount(CommandPalette, {
      props: {
        open: true,
      },
      attachTo: document.body,
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
      },
    });

    // 默认展示快速动作、项目和会话
    expect(document.body.textContent).toContain('新建会话');
    expect(document.body.textContent).toContain('项目管理');
    expect(document.body.textContent).toContain('导入外部会话');
    expect(document.body.textContent).toContain('算法导论');
    expect(document.body.textContent).toContain('动态规划专题讨论');

    // 搜索过滤
    const input = document.body.querySelector('input')!;
    expect(input).toBeDefined();
    input.value = '算法';
    input.dispatchEvent(new Event('input'));
    await (wrapper.vm as any).$nextTick();

    expect(document.body.textContent).toContain('算法导论');
    expect(document.body.textContent).not.toContain('动态规划专题讨论');

    // 点击项目触发项目选择
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const projectBtn = buttons.find((b) => b.textContent?.includes('算法导论'));
    expect(projectBtn).toBeDefined();
    projectBtn?.click();
    await flushPromises();

    expect(selectProject).toHaveBeenCalledWith('proj_algo');
    expect(fetchSessions).toHaveBeenCalledWith({ projectId: 'proj_algo' });
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
    wrapper.unmount();
  });
});
