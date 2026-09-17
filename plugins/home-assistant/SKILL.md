---
name: home-assistant
description: 联动本地 Home Assistant 智能家居网关，实现环境温湿度感知、智能照明/家电控制与主动关怀（CAP-034）。
---

# Home Assistant 智能家居技能

## 技能定位

当用户需要调节书房/卧室设备（如开启护眼台灯、调节空调温度、切换专注场景），或桌宠需要根据室内传感器状态（温度过高/过低、光线变暗、人体离席）进行主动关怀时，调用此技能与工具。

## 可用工具 (Tools)

1. `homeassistant_get_state`：查询指定实体的当前状态与属性。
   - 示例：`entityId: "sensor.study_temperature"` 查询书房当前温度。
2. `homeassistant_call_service`：向 Home Assistant 发送控制指令。
   - 示例：`domain: "light"`, `service: "turn_on"`, `entityId: "light.study_desk"` 开启护眼灯。

## 主动关怀准则

1. **环境自适应关怀**：当环境照度较低且用户正在学习/编程时，桌宠可温馨提醒用户是否需要帮忙开灯；
2. **温和不打扰**：严禁频繁未经允许控制高危设备（如电源主闸）；仅在用户授权后执行敏感操作。
