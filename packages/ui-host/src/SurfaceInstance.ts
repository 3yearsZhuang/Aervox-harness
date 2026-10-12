import { defineComponent, h, provide, type Component, type PropType } from 'vue';
import { UI_SURFACE_CONTEXT, type UISurfaceContext } from './surface-context';

// The keyed child keeps injection immutable across root replacement.
export default defineComponent({
  name: 'SurfaceInstance',
  inheritAttrs: false,
  props: {
    root: { type: [Object, Function] as PropType<Component>, required: true },
    context: { type: Object as PropType<UISurfaceContext>, required: true },
    viewProps: { type: Object as PropType<Record<string, unknown>>, required: true },
  },
  setup(props, { attrs }) {
    provide(UI_SURFACE_CONTEXT, props.context);
    return () => h(props.root, { ...props.viewProps, ...attrs, platform: props.context.platform });
  },
});
