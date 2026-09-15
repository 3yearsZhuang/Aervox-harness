import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import {
  AervoxButton,
  AervoxDialog,
  AervoxDialogHeader,
  AervoxNavDialog,
  AervoxConfirmDialog,
  AervoxDrawer,
  aervoxConfirm,
} from '../src/primitives';
import { Heart } from 'lucide-vue-next';
import * as elementUtils from '../src/utils/element';

describe('UI Primitives Test Suite', () => {
  describe('AervoxButton', () => {
    it('renders with default secondary variant and emits click event', async () => {
      const wrapper = mount(AervoxButton, {
        slots: {
          default: '点击测试',
        },
      });

      expect(wrapper.classes()).toContain('aervox-btn--secondary');
      expect(wrapper.text()).toContain('点击测试');

      await wrapper.trigger('click');
      expect(wrapper.emitted('click')).toHaveLength(1);
    });

    it('renders loading spinner and blocks click when loading', async () => {
      const wrapper = mount(AervoxButton, {
        props: {
          loading: true,
          variant: 'primary',
        },
        slots: {
          default: '提交中',
        },
      });

      expect(wrapper.classes()).toContain('is-loading');
      expect(wrapper.classes()).toContain('aervox-btn--primary');
      expect(wrapper.attributes('disabled')).toBeDefined();

      await wrapper.trigger('click');
      expect(wrapper.emitted('click')).toBeUndefined();
    });
  });

  describe('AervoxDialogHeader', () => {
    it('renders icon, title and subtitle, and emits close on close button click', async () => {
      const wrapper = mount(AervoxDialogHeader, {
        props: {
          title: '测试标题',
          subtitle: '这是副标题',
          icon: Heart,
        },
      });

      expect(wrapper.find('strong').text()).toBe('测试标题');
      expect(wrapper.find('small').text()).toBe('这是副标题');
      expect(wrapper.find('.heading-icon-wrap').exists()).toBe(true);

      await wrapper.find('.dialog-close-btn').trigger('click');
      expect(wrapper.emitted('close')).toHaveLength(1);
    });
  });

  describe('AervoxDialog', () => {
    it('renders title, content and footer within dialog', async () => {
      const wrapper = mount(AervoxDialog, {
        props: {
          modelValue: true,
          title: '弹窗测试',
          subtitle: '说明文本',
          icon: Heart,
        },
        slots: {
          default: '<div class="test-body">内容区</div>',
          footer: '<button class="test-footer-btn">确定</button>',
        },
        global: {
          stubs: {
            ElDialog: defineComponent({
              name: 'ElDialog',
              props: ['modelValue', 'width', 'showClose'],
              emits: ['update:modelValue', 'close'],
              setup(props, { slots, emit }) {
                return () =>
                  props.modelValue
                    ? h('div', { class: 'el-dialog-stub' }, [
                        slots.header ? slots.header() : null,
                        slots.default ? slots.default() : null,
                        slots.footer ? slots.footer() : null,
                      ])
                    : null;
              },
            }),
          },
        },
      });

      expect(wrapper.find('.test-body').text()).toBe('内容区');
      expect(wrapper.find('.test-footer-btn').text()).toBe('确定');
      expect(wrapper.text()).toContain('弹窗测试');
    });

    it('applies is-no-padding class when noPadding is true', async () => {
      const wrapper = mount(AervoxDialog, {
        props: {
          modelValue: true,
          noPadding: true,
        },
        global: {
          stubs: {
            ElDialog: defineComponent({
              name: 'ElDialog',
              props: ['modelValue'],
              setup(props, { slots }) {
                return () => (props.modelValue ? h('div', slots.default?.()) : null);
              },
            }),
          },
        },
      });

      expect(wrapper.find('.aervox-dialog-body').classes()).toContain('is-no-padding');
    });

    it('handles custom height and resets body maxHeight', async () => {
      const wrapper = mount(AervoxDialog, {
        props: {
          modelValue: true,
          height: '520px',
        },
        global: {
          stubs: {
            ElDialog: defineComponent({
              name: 'ElDialog',
              props: ['modelValue'],
              setup(props, { slots, attrs }) {
                return () =>
                  props.modelValue ? h('div', { class: 'el-dialog-stub', style: attrs.style }, slots.default?.()) : null;
              },
            }),
          },
        },
      });

      const stub = wrapper.find('.el-dialog-stub');
      expect((stub.element as HTMLElement).style.height).toBe('520px');
      const body = wrapper.find('.aervox-dialog-body');
      expect((body.element as HTMLElement).style.maxHeight).toBe('none');
      expect((body.element as HTMLElement).style.height).toBe('100%');
    });
  });

  describe('AervoxNavDialog', () => {
    it('switches active navigation item and triggers events', async () => {
      const activeKey = ref('tab-a');
      const items = [
        { id: 'tab-a', label: '分类 A', description: '描述 A' },
        { id: 'tab-b', label: '分类 B', description: '描述 B' },
      ];

      const wrapper = mount(AervoxNavDialog, {
        props: {
          modelValue: true,
          title: '导航弹窗',
          items,
          activeKey: activeKey.value,
          'onUpdate:activeKey': (val: string) => {
            activeKey.value = val;
          },
        },
        slots: {
          content: ({ activeKey }: { activeKey: string }) =>
            h('div', { class: 'active-view' }, `当前是 ${activeKey}`),
        },
        global: {
          stubs: {
            ElDialog: defineComponent({
              name: 'ElDialog',
              props: ['modelValue'],
              setup(props, { slots }) {
                return () =>
                  props.modelValue ? h('div', { class: 'el-dialog-stub' }, slots.default?.()) : null;
              },
            }),
          },
        },
      });

      expect(wrapper.find('.active-view').text()).toBe('当前是 tab-a');

      // Click tab-b
      const buttons = wrapper.findAll('.nav-sidebar-item');
      expect(buttons).toHaveLength(2);
      await buttons[1].trigger('click');

      expect(wrapper.emitted('update:activeKey')?.[0]).toEqual(['tab-b']);
      expect(wrapper.emitted('change')?.[0]).toEqual(['tab-b']);
    });

    it('does not constrain .aervox-nav-layout with fixed inline height', async () => {
      const wrapper = mount(AervoxNavDialog, {
        props: {
          modelValue: true,
          activeKey: 'test',
          items: [{ id: 'test', label: '测试' }],
        },
        global: {
          stubs: {
            ElDialog: defineComponent({
              name: 'ElDialog',
              props: ['modelValue'],
              setup(props, { slots }) {
                return () => (props.modelValue ? h('div', slots.default?.()) : null);
              },
            }),
          },
        },
      });

      const navLayout = wrapper.find('.aervox-nav-layout');
      expect(navLayout.attributes('style')).toBeFalsy();
    });
  });

  describe('AervoxConfirmDialog', () => {
    it('respects acknowledge requirement before confirming', async () => {
      const wrapper = mount(AervoxConfirmDialog, {
        props: {
          modelValue: true,
          title: '危险操作',
          message: '确定要清空全部配置吗？',
          requireAcknowledge: true,
          acknowledgeText: '我已知晓风险',
          variant: 'danger',
        },
        global: {
          stubs: {
            ElDialog: defineComponent({
              name: 'ElDialog',
              props: ['modelValue'],
              setup(props, { slots }) {
                return () =>
                  props.modelValue
                    ? h('div', { class: 'el-dialog-stub' }, [
                        slots.default?.(),
                        slots.footer?.(),
                      ])
                    : null;
              },
            }),
          },
        },
      });

      expect(wrapper.text()).toContain('确定要清空全部配置吗？');

      // Find confirm button
      const buttons = wrapper.findAllComponents(AervoxButton);
      const confirmBtn = buttons.find((b) => b.props('variant') === 'danger');
      expect(confirmBtn?.props('disabled')).toBe(true);

      // Check acknowledge checkbox
      const checkbox = wrapper.find('input[type="checkbox"]');
      await checkbox.setValue(true);

      expect(confirmBtn?.props('disabled')).toBe(false);
      await confirmBtn?.trigger('click');
      expect(wrapper.emitted('confirm')).toHaveLength(1);
    });
  });

  describe('AervoxDrawer', () => {
    it('renders drawer content, locks body scroll and triggers close on escape key', async () => {
      document.body.style.overflow = 'auto';

      const wrapper = mount(AervoxDrawer, {
        props: {
          modelValue: true,
          title: '抽屉回看',
          noPadding: true,
        },
        slots: {
          default: '<div class="drawer-inner-content">历史对话</div>',
        },
        attachTo: document.body,
      });

      expect(document.body.innerHTML).toContain('抽屉回看');
      expect(document.body.innerHTML).toContain('历史对话');
      expect(document.body.style.overflow).toBe('hidden');
      expect(document.querySelector('.drawer-body')?.classList.contains('is-no-padding')).toBe(true);

      // Trigger Escape
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      const stopSpy = vi.spyOn(escapeEvent, 'stopPropagation');
      window.dispatchEvent(escapeEvent);

      expect(stopSpy).toHaveBeenCalled();
      expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
      expect(wrapper.emitted('close')).toHaveLength(1);

      wrapper.unmount();
      expect(document.body.style.overflow).toBe('auto');
    });
  });

  describe('aervoxConfirm service', () => {
    it('resolves true on ElMessageBox confirm, and false on cancel', async () => {
      const confirmSpy = vi.spyOn(elementUtils.ElMessageBox, 'confirm');

      // Success branch
      confirmSpy.mockResolvedValueOnce('confirm' as any);
      const res1 = await aervoxConfirm({ title: '确认', message: '继续吗？' });
      expect(res1).toBe(true);
      expect(confirmSpy).toHaveBeenCalledTimes(1);

      // Cancel branch
      confirmSpy.mockRejectedValueOnce(new Error('cancel'));
      const res2 = await aervoxConfirm({ title: '确认', message: '继续吗？' });
      expect(res2).toBe(false);
      expect(confirmSpy).toHaveBeenCalledTimes(2);

      confirmSpy.mockRestore();
    });
  });
});
