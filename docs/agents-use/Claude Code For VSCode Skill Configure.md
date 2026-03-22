# Claude Code For VSCode Skill 配置指南

## 目录结构

```
.claude/                          # Agent 配置目录
└── skills/
    └── vscode-debugger/
        └── SKILL.md              # Agent Skill 定义文件

docs/agents-use/
└── Claude Code For VSCode Skill Configure.md   # 本文档
```

## 如何为项目配置 Skill

在项目的 `.claude/skills/vscode-debugger/` 目录下放置 Skill 文件。

**Skill 文件来源**：

```
vscode-debugger/                          # 本仓库
└── agent/
    └── skills/
        └── vscode-debugger/
            ├── SKILL.md                 # 英文版 Skill
            └── SKILL-ZH.md              # 中文版 Skill
```

将上述文件复制到目标项目的 `.claude/skills/vscode-debugger/` 目录下。

示例项目结构：

```
your-project/
├── .claude/
│   └── skills/
│       └── vscode-debugger/
│           └── SKILL.md                 # 从本仓库 agent/skills/vscode-debugger/SKILL.md 复制
├── .vscode/
│   └── launch.json                     # VSCode 调试配置
└── your-app.py
```
