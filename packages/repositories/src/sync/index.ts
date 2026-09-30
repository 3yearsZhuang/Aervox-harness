/**
 * Aervox｜思隅 @aervox/repositories — 同步/版本层导出
 *
 * 注意：`p2p-pairing` / `p2p-changeset` / `p2p-discovery` / `p2p-transport` 为 ITER-028
 * **探索性**基础设施。自本切片起，局域网发现（UDP 多播信标 + 静态对端列表）与 TCP 传输
 * （分帧 + 承诺-揭示握手 + 加密 Changeset 双向交换）已在 **127.0.0.1 环回 socket** 上端到端验证；
 * 但**仍未接线**到任何产品路径：无 UI、无后台调度、无 Electron/Capacitor 集成、
 * 无 mDNS/DNS-SD、无 TLS、无真实多设备（跨机型/跨 Wi-Fi）验收。
 * 对外导出仅为后续独立接入与测试复用，不代表已交付能力。
 */
export * from "./git-snapshot.js";
export * from "./p2p-pairing.js";
export * from "./p2p-changeset.js";
export * from "./p2p-discovery.js";
export * from "./p2p-transport.js";
