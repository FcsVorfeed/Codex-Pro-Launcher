## 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**
- No abstractions for single-use code.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**
When editing existing code:

- Don't refactor things that aren't broken.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 最高准则
- 任何时候都要关注隐私
- 模块化开发，每个系统单独文件夹，避免外部单文件聚合

## 私有目录边界
- `private/` 是本项目唯一私有目录，整个目录必须被 Git 忽略，里面不要设置任何需要提交的例外文件。
- 真实账号、Token、密钥、邮箱、公司信息、服务地址、本机路径、构建产物、发布 exe、Excel、内部文档、商业计划、云函数源码和远端部署资料都必须放进 `private/`。
- 公开源码区只允许放代码、脚本、公开占位说明和不含真实值的测试数据；如果代码需要读取私有信息，只能读取 `private/` 内的配置文件，不要把真实值写进源码或公开文档。
- 新增文件前先判断它是否能公开；不能确定时先放 `private/`，再和用户确认是否需要抽象成公开占位或源码逻辑。
- 排查私有资料时不要只依赖默认 `rg --files` 或 Git 跟踪列表，因为它们会隐藏被忽略的 `private/`；必须直接检查 `private/` 路径，必要时用 `rg --no-ignore private/`，但不要把 `private/` 内容提交、移动回公开区，或在根目录重建 `docs/`、`plans/`、`cloudfunctions/` 等私有目录。

## General instructions
- 用户的话如果里面存在奇怪的标点符号和词汇，有可能是因为使用了语音输入法导致一些同音字或者类似的情况可以酌情判断
- 用户提出需求后先分析不要直接修改，先将方案列举出来，跟用户进行讨论后再开始
- 优先以第一性原理思路解决问题而不是靠Fallback规避问题
- 规则优先级
  - 第一优先级：不误删代码、保留注释掉的功能模块、编辑前后核对上下文、关注内存与性能
  - 第二优先级：命名、注释、排版风格要求
- 当需要用户做选择或确认时（如方案选择、是否执行、确认修改等）
  - 每个方案作为一个选项（按推荐顺序列出）
    - 标题：方案名
    - 说明：简要说明
    - 评估：方案优缺点

- 注意内存泄漏和性能问题
- 功能开发后要自动提权注入 
  - 优先使用npm run inject刷新当前源码
  - 注入后使用功能专属CDP/DOM探针或相关检查脚本验证真实行为
  - 避免重复npm run inject:rust:dev
- Dev runtime 目录提权操作
- 注入成功后需要验证版本号
- 使用GIT进行修改校验

## GIT操作说明
- GIT默认使用提升权限进行操作
- GIT提交需填写英文说明

## SVN操作说明
- SVN默认使用提升权限进行操作
- SVN提交需填写中文说明
- SVN 提交中文说明时禁止直接使用 `svn commit -m "中文"`；
- 必须先写入 UTF-8 编码的临时说明文件，再用 `svn commit --encoding UTF-8 -F <file>` 提交
```
$logFile = "private\tmp\svn-commit-message.txt"
"说明内容" | Set-Content -Path $logFile -Encoding utf8NoBOM
svn commit <paths> --encoding UTF-8 -F $logFile
```

## CodeReview
- 使用子代理进行Code Review（如果你是子代理则无视这条）
  - 给Code Review的子代理的说明最后添加约束提示词：
  - 你是一个仅做只读操作的Code Review子代理
  - 禁止开新子代理
  - 禁止开新子线程
  - 禁止修改
  - 禁止提交
  - 同时对`private`目录使用SVN进行CodeReview
- CodeReview时子代理可能因为网络问题卡顿，尽可能不要轻易跳过
- fork_context 时不要指定角色

## 子代理
- 如果你是一个CodeReview子代理:
  - 禁止开新子代理
  - 禁止开新子线程
  - 禁止修改
  - 禁止提交

## 输出协议（打印标记）
- Read memory时必须在聊天窗口中打印:📦->读取记忆：文件超链接
- 读取Skill时必须在聊天窗口中打印:🎯->读取Skill：技能名字+文件超链接
- 使用SVN时必须在聊天窗口中打印:📀->使用SVN：命令简要说明
- 使用GIT时必须在聊天窗口中打印:📀->使用GIT：命令简要说明
- 经验总结时必须在聊天窗口中打印:🌸->总结经验：文件超链接，换行后加 `- 经验内容`
- 编辑文件时必须在聊天窗口中打印:📃->编辑文件：换行后+文件超链接
- 开子代理时必须在聊天窗口种打印:🌐->开启代理：简要说明
- 浏览网络时必须在聊天窗口中打印:🔍->浏览网络：网站超链接+浏览意图
- 远端部署操作相关的问题必须打印:❓->远端部署：操作说明+产生影响+解决方案
- 本地文件超链接统一使用 `[相对路径名称](<C:/path/to/file>)` 格式；Windows 路径必须把 `\` 转成 `/`；多文件换行显示
- 需求完成后必须在聊天窗口详细输出：
  - 业务的实现方式原理:⚙️->业务原理：
  - 所有Fallback的方式:🩹->Fallback：
  - 可能存在的边界问题:🚧->边界问题：

## 项目规范
- 所有功能都要支持多语言
- 所有功能模块优先分开目录和文件，用模块化黑箱理念开发以便后续更新修改维护
- 持续维护一份路由文档 `private/MODULES.md` 各功能模块说明（按需更新）
- 能用官方Codex客户端已有的方法就不要自己去猜测和硬构造实现
- 非必要时不要使用硬编码，要考虑用户可能包括但不限于如下情况：
  - 不同系统版本
  - 不同电脑
  - 不同用户
  - 不同账号
  - 不同路径
  - 多语言适配
- 如有硬编码部分需要打印出来避免被忽略用户无法评估
- 禁止用文案判断界面元素兜底，需要获取界面元素的时候可以让用户配合打开对应界面定位
- 避免获取数据之类的方式靠猜，而是优先直接尝试获取真实的数据源头，如果需要类似拟合方案要跟用户讨论
- 如果方案涉及旧数据必须询问用户是清理还是兼容或者其他处理方式
- 项目所有文档说明用中文

## Code style
- 函数方法字段上方都必须要添加注释说明
- 函数体内每个逻辑段前需要添加意图注释说明“这一段在做什么/为什么做”
- 所有注释都要使用中文英文双语注释（尽可能中文第一行英文第二行，除非某些特别排版美化需求）
