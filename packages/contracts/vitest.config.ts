// 契约包用例含 OpenAPI 文档全量生成（惰性构建 + 缓存），CPU 争抢下远超 vitest 默认 5s 超时；
// 与其它包一致接入共享配置（当前 15s 超时、半核数并发，取值理由见 vitest.shared.ts）。
export { default } from '../../vitest.shared';
