// CR-060：本出口只暴露**通用**插件运行时；具体插件定义由组合根按包路径装配
// （`@aervox/ui/plugins/<id>`），宿主包不聚合任何具体插件模块。
export * from './plugin-runtime';

