import { CalendarClock } from 'lucide-vue-next';
import { defineComponent, h } from 'vue';
import type { BuiltinUIPlugin } from '@aervox/ui/plugin-api';
import CampusCard from './CampusCard.vue';
import CampusDrawer from './CampusDrawer.vue';
import CampusNavItem from './CampusNavItem.vue';
import { useCampusStore, releaseCampusStore } from './store.js';

export { CampusCard, CampusDrawer, CampusNavItem };
export { useCampusStore, createCampusUIStore, disposeCampusStore } from './store.js';
export { createCampusClient } from './api.js';

export const flowCampusUIPlugin: BuiltinUIPlugin = {
  id: 'flowcampus',
  surfaces: ['workbench', 'companion'],
  setup(registry, context, lifecycle) {
    if (!context) throw new Error('flowcampus_ui_context_required');
    const store = useCampusStore(context, lifecycle);
    const taskCenterCard = defineComponent({ setup: () => () => h(CampusCard, { beforeOpen: () => context.navigation.closeTaskCenter() }) });
    const cleanups = [
      registry.registerCard({ id: 'flowcampus', label: '只争朝夕', description: '课程、出发时间与可用空档',
        icon: CalendarClock, summary: () => store.plan.value?.nextEvent?.title ?? '添加课程与路线',
        action: () => store.open(), priority: 70 }),
      registry.registerSlotComponent('sidecards:widgets', CampusCard, { id: 'flowcampus:card', priority: 70 }),
      registry.registerSlotComponent('nav:menu-items', CampusNavItem, { id: 'flowcampus:nav', priority: 70 }),
      registry.registerSlotComponent('workbench:drawers', CampusDrawer, { id: 'flowcampus:drawer', priority: 70 }),
      registry.registerSlotComponent('taskcenter:cards', taskCenterCard, { id: 'flowcampus:taskcenter', priority: 70 }),
      registry.registerSlotComponent('companion:cards', CampusCard, { id: 'flowcampus:companion-card', priority: 70 }),
      registry.registerSlotComponent('companion:drawers', CampusDrawer, { id: 'flowcampus:companion-drawer', priority: 70 }),
    ];
    store.start();
    let disposed = false;
    return () => { if (disposed) return; disposed = true; cleanups.reverse().forEach(cleanup => cleanup()); releaseCampusStore(context, store); };
  },
};
export default flowCampusUIPlugin;
