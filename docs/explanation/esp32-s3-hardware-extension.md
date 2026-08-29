# ESP32-S3-WROOM-2-N32R16V 硬件延伸方案

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-29

> 文档编号：AVX-EXPL-005
> 类型：Explanation
> 版本：v0.2.1
> 更新日期：2026-08-29
> 状态：Review Candidate
> 责任角色：技术负责人（待指定）
> 关联：[PRD](../reference/PRD.md)、[架构设计](../reference/ARCHITECTURE.md)、[数据与隐私规范](../reference/DATA_PRIVACY.md)、[威胁模型](../reference/THREAT_MODEL.md)、[需求追踪与交付基线](../reference/REQUIREMENTS_TRACEABILITY.md)

本文恢复并完善 ESP32-S3 硬件延伸提案，说明如何把 `ESP32-S3-WROOM-2-N32R16V` 做成 Aervox｜思隅的物理桌宠终端。本文是评审输入，不是已批准的生产规格、设备协议、固件安全标准或新增 CAP。

## 一句话模型

ESP32 只把 Aervox 已授权的表现意图转换为屏幕、灯光、音效和低敏物理输入；API、Worker 和 SQLite 继续拥有账户、工作区、会话、学习、记忆、日记、通知、同意、撤销和删除事实。

```text
Aervox API / Worker
        ↓ Turn/SSE、通知、权限和策略
Electron DeviceHost
        ↓ 表现映射、队列、重连、ACK
USB CDC（R0）或 TLS Device Gateway（后续）
        ↓
ESP32-S3 物理桌宠
```

## 1. 目标和边界

### 1.1 R0 目标

1. 复用现有 `PetCommand`、`emote` SSE 和精灵状态，驱动可见物理表现。
2. 通过按键完成继续、开始短练习、稍后提醒和静音等确定性操作。
3. 设备断开、重启、升级或故障时，Web/Desktop 核心学习流程仍可用。
4. 建立设备命令的版本、序号、TTL、幂等和 ACK 语义。

### 1.2 不变量

- 不在 ESP32 上运行模型，不持有模型密钥，不直写 API 或 SQLite。
- 不把 Flash 当作消息、会话、记忆或日记第二真源。
- 不把 `PetCommand.move` 直接解释为电机或舵机参数。
- 首版不启用麦克风、摄像头、屏幕捕获和环境传感器。
- 主动提醒必须支持频控、免打扰、暂停、静音和关闭。

### 1.3 CAP 映射

| 能力 | 角色 | 首版允许覆盖 | 不覆盖 |
|---|---|---|---|
| `CAP-001` 桌宠入口 | 主能力 | 物理状态、动作、轻提示和按键入口 | 学习业务真源 |
| `CAP-018` 桌面化与 Live2D | 辅能力 | 与 Electron 共享表现语义 | 配网、OTA、量产安全 |
| `CAP-030` 主动提醒深化 | 后续 | 有频控的物理提醒 | 默认主动打扰 |
| `CAP-027` 本地优先与多工作区 | 后续 | 设备离线队列或网关 | 少量状态缓存 |
| `CAP-002/007/012` | 后续 | Push-to-Talk 专项评审后 | 首版麦克风采集 |

若配网、设备身份、OTA、离线同步或传感器形成独立生命周期能力，应建立设备专属的新能力基线（编号须另经 CR 裁定），不能占用或静默扩写已登记的 `CAP-033`/`CAP-018`。

## 2. 模组事实和工程约束

以 Espressif `ESP32-S3-WROOM-2` 数据手册 v1.7 的 `N32R16V` 条目为设计输入：

| 项目 | 模组级事实 | 工程结论 |
|---|---|---|
| SoC | 双核 Xtensa LX7，最高 240 MHz | 做动画、音频 DMA、VAD 等边缘任务，不做本地模型主机 |
| 存储 | 32 MB Octal Flash、16 MB Octal PSRAM、512 KB SRAM | 放资产和双 OTA，不保存业务历史 |
| 无线 | 2.4 GHz Wi-Fi、BLE 5 | 后续配网/网关；R0 优先 USB |
| 外设 | SPI、I²C、I²S、LCD、USB FS、PWM、ADC、触摸、UART | 连接 LCD、RGB、I²S 功放和按键 |
| 供电 | 3.0～3.6 V，标称 3.3 V | 必须按 RF、背光和功放并发验证 |
| RF 峰值 | Wi-Fi TX 典型约 285～355 mA | 外部供电至少 0.5 A，原型按 1 A 级评估 |
| 尺寸/温度 | 18.0 × 25.5 × 3.1 mm；-40～65 °C | 需测整机温升和天线布局 |

红线：GPIO47/48 是 R16V 的 1.8 V 域；GPIO0/3/45/46 涉及启动/JTAG/VDD_SPI；GPIO19/20 默认 USB；GPIO39～42 为 JTAG；GPIO43/44 为 UART0；Octal Flash/PSRAM 使用的内部 GPIO 不作为用户外设。ADC 测量优先 ADC1，天线 keepout 区域不铺铜、不放 DC/DC、功放和高速时钟。

## 3. Rev-A 物理方案

| 子系统 | 推荐方案 | 暂缓方案 |
|---|---|---|
| 显示 | SPI LCD 240×240 或 320×240 | 16-bit RGB、视频、正式 Live2D |
| 指示 | RGB LED、LCD 背光 | 高密度灯阵列 |
| 输入 | 2～3 个实体按键 | 旋钮、触摸阵列、压力传感器 |
| 音频输出 | I²S Class-D + 小扬声器，短音效 | 连续语音和大功率播放 |
| 音频输入 | 不装麦克风 | Push-to-Talk、VAD、唤醒词、全双工 |
| 供电 | USB-C 5 V → 3.3 V 稳压 | 电池和充电管理 |
| 运动 | 无电机、无舵机 | 机械动作需独立安全协议 |

候选引脚：I²S GPIO4～7，I²C GPIO8/9，SPI LCD GPIO10～14，背光 GPIO15，RGB GPIO16，按键 GPIO17/18，USB GPIO19/20，扩展/ADC1 GPIO1/2/21/38，UART0 测试 GPIO43/44。进入 PCB 前必须用 ESP-IDF GPIO matrix 和原理图评审确认。

电源按瞬态和噪声设计：3.3 V 稳压器先按 1 A 级评估；模组、功放和显示分别去耦；`EN` 不悬空，可从 10 kΩ/1 µF RC 起步并按上电时序调参；Class-D、DC/DC、LCD 时钟和 USB 高速边沿远离天线和触摸线；USB-C 增加 ESD、过流和反接保护。

## 4. 系统分层

### 4.1 API/Worker

API/Worker 继续拥有 Turn/SSE、学习记录、通知、同意、撤销、删除和设备绑定事实。设备不能通过自报的 `workspaceId` 或 `subjectUserId` 获取权限，网关必须由认证主体、绑定关系和设备凭据解析授权。

### 4.2 Electron DeviceHost

DeviceHost 位于 Electron 主进程或独立受限进程，负责消费 `desktopTransport` 的 `emote`、表现映射、串口独占和重连、`commandId`/序号/TTL、ACK、权限门控、Feature Flag、降级和脱敏观测。Renderer 只能调用 schema 化 preload 方法，不能任意写串口或更新固件。

### 4.3 ESP32 固件

固件划分为 `boot/recovery`、`transport_usb`、`device_protocol`、`pet_renderer`、`input`、`storage` 和 `ota`。它只产生 ACK、输入事件、版本信息和有限诊断，不接受脚本、不执行任意模型文本、不生成学习事实。

## 5. 设备协议

`PetCommand` 是跨端表现语义，不包含设备身份、序号、TTL、能力和 ACK，因此不能直接作为线协议。USB 原型可用 JSON Lines，联网量产再评估 CBOR 或 protobuf。

```json
{
  "protocolVersion": 1,
  "deviceId": "dev_01",
  "commandId": "cmd_01",
  "sequence": 42,
  "issuedAt": "2026-08-28T08:00:00.000Z",
  "expiresAt": "2026-08-28T08:00:10.000Z",
  "priority": "normal",
  "kind": "pet_state",
  "payload": { "state": "review", "emote": "think", "sound": "review_start", "brightness": 80 }
}
```

设备回执必须包含 `deviceId`、`bootId`、`commandId`、`sequence`、`status`、`occurredAt` 和 `firmwareVersion`；输入事件必须包含 `eventId`、`bootId`、`localSequence`、`kind`、`input` 和 `occurredAt`。

协议行为：重复 `commandId` 只产生一次物理副作用并回相同 ACK；序号单调递增；过期命令拒绝执行；未知版本或 `kind` 拒绝并回报；队列有上限；断线只缓存最后安全状态和有限低敏输入；ACK 不代表模型或学习业务成功。

## 6. 存储、身份和 OTA

32 MB Flash 优先服务可恢复性：

```text
factory/recovery       固件恢复入口
ota_0 / ota_1          双应用分区和回滚空间
encrypted_nvs          配置、绑定状态和密钥材料
assets                 动画与音效资源
diagnostics            有限崩溃摘要和协议统计
```

R0 不要求 ESP32 联网，使用 USB CDC，不放生产凭据。H1 才引入 BLE 配网、一次性配对、短期最小 scope 凭据、TLS、轮换、撤销、在线状态和网关队列。Secure Boot、Flash Encryption、eFuse/HMAC 或外部安全元件的选型必须由 `ADR-016` 冻结，并覆盖工厂注入、反回滚、掉电恢复、丢失、转移、恢复出厂和 kill switch。

## 7. 音频、隐私与安全

首版只播放短音效并提供硬件功放静音。若进入 Push-to-Talk：用户明确按键后采集，麦克风电源和时钟可硬件关闭，采集状态由同源 LED 显示，原始音频短暂缓冲且默认不落盘，撤销权限后设备本地也停止采集。唤醒词、双麦克风 AEC、摄像头和持续环境采集需另建 CR，加入[威胁模型](../reference/THREAT_MODEL.md)和[数据隐私发布门禁](../reference/DATA_PRIVACY.md#privacy-gates)。

设备撤权、解绑、丢失和恢复出厂必须先进入 deny 控制链路，再关闭连接、清理队列和凭据。设备日志不得包含完整会话、音频、凭据或 Restricted 原文。设备故障不影响 Web/Desktop，撤销后的离线缓存不得恢复执行。

## 8. 故障、验证与实验

| 故障 | 设备行为 | Aervox 行为 |
|---|---|---|
| USB 断开 | `offline`，停止队列 | Web/Desktop 继续工作 |
| 命令重复/过期 | 去重或回 `expired` | 不重复提醒，不伪造送达 |
| 设备重启 | `booting` → 安全 `idle` | 重新协商，不重放过期命令 |
| 固件校验失败 | recovery，禁止业务输出 | 保留 Web/API，提示恢复 |
| LCD/功放故障 | 保留可用输出或硬件静音 | 桌面端显示故障 |
| 网关撤销 | 停止命令并清理凭据 | 提供重新绑定，保留学习数据 |

R0 必须测试正常/重复/乱序/过期/未知版本、大包拒绝、掉电、看门狗、队列满、温升、RF 与功放/背光并发、24 小时运行、72 小时 soak、签名校验和 OTA 回滚。用户实验沿 `EXP-001` 比较 Web、Electron 和 Electron + ESP32，主要指标为闭环完成率、WELS、D1/D7 和复习完成率，护栏指标为退出率、断连率、ACK 超时、隐私顾虑和无障碍阻断。

## 9. 路线与实施动作

| 阶段 | 交付 | 准入 | 退出 |
|---|---|---|---|
| R0 | 开发板、USB CDC、LCD/RGB/按键 | `CR-013` 提案、EXP 分层、无捕获能力 | 核心流程无设备可用，表现稳定 |
| R3 | Rev-A PCB、DeviceHost、ACK/重连 | R0 有价值证据，`ADR-016` 评审 | soak、断线、重启、回滚通过 |
| H1 | 配网、绑定、TLS 网关、短期凭据 | 身份、隐私和威胁评审 | 撤销、丢失、OTA 和隔离通过 |
| H2 | 低敏双向输入、有限离线队列 | H1 控制面稳定 | 幂等、删除、导出和指标闭环通过 |
| H3 | Push-to-Talk、硬件静音 | 设备捕获专项 CR 批准 | 同意、指示、删除和音频质量通过 |

进入编码前必须：

1. 建立 `CR-013-esp32-s3-hardware-endpoint.md`，列出受影响的 CAP/FR/BR/NFR/DATA/SEC/PRIV/OPS/AC/TC。
2. 建立 `ADR-016`，冻结固件位置、ESP-IDF 工具链、设备身份、USB/Wi-Fi、配网、OTA、撤销和恢复出厂。
3. 建立 `docs/reference/DEVICE_PROTOCOL.md`，收敛 schema、帧边界、状态机、错误和兼容规则。
4. 建立 `firmware/esp32-s3/` 或经 ADR 批准的独立仓库，并用 `mise.toml` 固定 ESP-IDF、CMake、Ninja、esptool。
5. 实现后在[追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记实现位置、日期、验证和来源。

## 10. 参考资料

- [ESP32-S3-WROOM-2 Datasheet v1.7](https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-2_datasheet_en.pdf)
- [ESP32-S3 Series Datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf)
- [ESP-IDF ESP32-S3 Programming Guide](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/)

外部资料只提供模组事实和 SDK 参考；产品范围、权限、数据处理、威胁和发布门禁以仓库内 PRD、SRS、架构、隐私、威胁模型、ADR 和追踪基线为准。
