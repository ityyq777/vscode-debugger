# VSCode Debugger Proxy 调试指南

## 启动扩展

1. 打开 VSCode
2. 文件 -> 打开文件夹 -> 选择 `vscode-debugger-proxy` 文件夹
3. 按 **F5** 启动扩展
4. 验证扩展已启动：

```powershell
curl.exe http://localhost:4711/health
# 返回: {"status":"ok","service":"vscode-debugger-proxy"}
```

## 标准调试流程

### PowerShell 环境

```powershell
# 1. 设置断点（支持多文件）
Invoke-RestMethod -Uri http://localhost:4711/breakpoints -Method POST -ContentType "application/json" -Body '{"d:/myservers/vscode-debugpy-agent-skill/test/test-flask-app/app.py": [29,30]}'

# 2. 启动调试（根据 launch.json 中的配置名称）
Invoke-RestMethod -Uri http://localhost:4711/launch -Method POST -ContentType "application/json" -Body '{"config": "Python: Flask"}'

# 3. 等待断点命中（阻塞）
$r = Invoke-RestMethod -Uri http://localhost:4711/wait -Method POST -ContentType "application/json"
$r | ConvertTo-Json -Depth 3

# 4. 查看变量（需要 frameId）
# 请求体格式：{ "frameId": 4, "scope": { "Locals": ["user_id"], "Globals": ["*"] } }
# - scope 可选，不传则返回 Locals 和 Globals 下所有变量（不推荐，传输量大）
# - varNames 为 ["*"] 表示获取该 scope 下所有变量
# - frameId 不传则使用当前断点位置
Invoke-RestMethod -Uri http://localhost:4711/variables -Method POST -ContentType "application/json" -Body '{"frameId": ' + $r.frameId + ', "scope": {"Locals": ["user_id"], "Globals": ["*"]}}'

# 5. 执行表达式（类似调试控制台 REPL）
Invoke-RestMethod -Uri http://localhost:4711/evaluate -Method POST -ContentType "application/json" -Body '{"expression": "user_id + 10", "frameId": ' + $r.frameId + '}'

# 6. 单步执行（next, stepIn, stepOut 立即返回）
Invoke-RestMethod -Uri http://localhost:4711/control -Method POST -ContentType "application/json" -Body '{"action": "next"}'

# 7. 继续执行到下一个断点（wait 和 timeout 仅对 continue 有效）
Invoke-RestMethod -Uri http://localhost:4711/control -Method POST -ContentType "application/json" -Body '{"action": "continue", "wait": true, "timeout": -1}'

# 8. 重新启动调试（等同于 stop + launch）
Invoke-RestMethod -Uri http://localhost:4711/relaunch -Method POST -ContentType "application/json" -Body '{"config": "Python: Flask"}'

# 9. 获取栈帧信息
Invoke-RestMethod -Uri http://localhost:4711/stacktrace -Method GET
```

### Bash / Shell 环境

```bash
# 1. 设置断点（支持多文件）
curl -X POST http://localhost:4711/breakpoints \
  -H "Content-Type: application/json" \
  -d '{"d:/myservers/vscode-debugpy-agent-skill/test/test-flask-app/app.py": [29], "d:/myservers/vscode-debugpy-agent-skill/test/test-flask-app/utils.py": [10, 15]}'

# 2. 启动调试（根据 launch.json 中的配置名称）
curl -X POST http://localhost:4711/launch \
  -H "Content-Type: application/json" \
  -d '{"config": "Python: Flask"}'

# 3. 等待断点命中（阻塞）
curl -X POST http://localhost:4711/wait \
  -H "Content-Type: application/json"

# 4. 查看变量（需要 frameId，从上一步响应中获取）
# 请求体格式：{ "frameId": 4, "scope": { "Locals": ["user_id"], "Globals": ["*"] } }
# - scope 可选，不传则返回 Locals 和 Globals 下所有变量（不推荐，传输量大）
# - varNames 为 ["*"] 表示获取该 scope 下所有变量
# - frameId 不传则使用当前断点位置
curl -X POST http://localhost:4711/variables \
  -H "Content-Type: application/json" \
  -d '{"frameId": 4, "scope": {"Locals": ["user_id"], "Globals": ["*"]}}'

# 5. 执行表达式（类似调试控制台 REPL）
curl -X POST http://localhost:4711/evaluate \
  -H "Content-Type: application/json" \
  -d '{"expression": "user_id + 10", "frameId": 4}'

# 6. 单步执行（next, stepIn, stepOut 立即返回）
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "next"}'

# 7. 继续执行到下一个断点（wait 和 timeout 仅对 continue 有效）
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "continue", "wait": true, "timeout": -1}'

# 8. 重新启动调试（等同于 stop + launch）
curl -X POST http://localhost:4711/relaunch \
  -H "Content-Type: application/json" \
  -d '{"config": "Python: Flask"}'

# 9. 获取栈帧信息
curl http://localhost:4711/stacktrace

# 10. 获取所有断点列表
curl http://localhost:4711/breakpoints
```

## 接口状态说明

- **`/launch`**: 如果调试器已启动，返回 `success: true`
- **`/stop`**: 如果调试器已停止，返回 `success: true`
- **其他接口**: 如果调试器未启动，返回错误

## 注意事项

1. **先设置断点再启动调试**（或启动调试后再设置断点，两者皆可）
2. **`/wait` 返回的 `frameId` 是凭证**，后续请求 `/variables`、`/evaluate` 和 `/control` 应携带此凭证
3. 如果用户手动 continue/step 导致 `frameId` 变化，接口会返回错误提示 Agent 状态已变化
4. 触发断点：在浏览器另一个终端执行 `curl.exe http://127.0.0.1:5000/users/1`
