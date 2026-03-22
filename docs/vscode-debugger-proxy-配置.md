# VSCode Debugger Proxy 配置指南

## 配置项

VSCode Debugger Proxy 提供以下配置项（在 VSCode 设置中调整）：

### `debuggerProxy.port`

- **类型**: `number`
- **默认值**: `4711`
- **说明**: HTTP 服务器端口号

### `debuggerProxy.timeout`

- **类型**: `number`
- **默认值**: `30000`（毫秒）
- **说明**: 阻塞式调试操作（如 `/wait`、`continue`）的默认超时时间

### `debuggerProxy.autoStart`

- **类型**: `boolean`
- **默认值**: `false`
- **说明**: VSCode 窗口加载时自动启动调试代理服务器

---

## 状态栏

扩展在 VSCode 底部栏左侧显示状态按钮：

| 状态 | 显示 | 含义 |
|------|------|------|
| 停止 | `vdp ×` | 服务器未运行，点击启动 |
| 运行 | `vdp √ (4711)` | 服务器运行中，显示端口号，点击停止 |

---

## 配置示例

在 VSCode 设置（`.vscode/settings.json`）中添加：

```json
{
  "debuggerProxy.port": 4711,
  "debuggerProxy.timeout": 30000,
  "debuggerProxy.autoStart": false
}
```
