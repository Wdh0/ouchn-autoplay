# 国开学习网自动连播

国家开放大学学习平台 (lms.ouchn.cn) 的 Tampermonkey 辅助脚本。

启发于国开学习课程的不便，遂开发此工具用于辅助学习。经过多次调整与长期试用推出此正式版，日常使用十分稳定。

> **提示**：启动工具时尽可能不要最小化浏览器，保持在目标页面。可以缩小窗口，以此避免潜在问题。

## 功能

- 视频/音频自动播放，播完自动跳转下一节
- 页面/资料自动翻页
- 参考资料自动预览
- 作业/考试/问卷/讨论/直播自动跳过
- 视频倍速（普通 2.0x，阈值视频 1.75x）
- 视频画质自动最低（480p）
- 转码卡住自动刷新重试
- 浏览器最小化、切换标签页时保持后台运行
- 页面意外重载后自动恢复
- 反检测：随机延迟、会话休息、行为模拟
- 默认暂停状态，点击右下角指示器启动

## 安装

**一键安装**：点击下方链接，Tampermonkey 会自动弹出安装窗口。

[![安装](https://img.shields.io/badge/一键安装-Tampermonkey-blue)](https://github.com/Wdh0/ouchn-autoplay/raw/main/ouchn_autoplay.user.js)

或手动安装：

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 [ouchn_autoplay.user.js](https://github.com/Wdh0/ouchn-autoplay/raw/main/ouchn_autoplay.user.js)（Tampermonkey 会弹出安装窗口）
3. 登录国开学习网，进入课程全屏学习页面
4. 点击右下角指示器启动

## 配置

编辑脚本顶部的常量：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `VIEW_MIN_SEC` / `VIEW_MAX_SEC` | 18 / 40 | 页面类活动阅读时间（秒） |
| `SESSION_MIN` / `SESSION_MAX` | 5 / 9 | 连续多少活动后休息 |
| `BREAK_MIN_SEC` / `BREAK_MAX_SEC` | 30 / 60 | 休息时长（秒） |
| `MID_PAUSE_CHANCE` | 0.12 | 播放中途暂停概率（0 关闭） |
| `STUCK_CHECK_SEC` | 22 | 转码卡住检测等待（秒） |
| `MAX_STUCK_RETRIES` | 3 | 转码刷新重试次数 |
| `DEBUG` | false | 控制台日志开关 |

## 免责声明

本脚本仅供学习交流使用。使用者自行承担因使用本脚本产生的一切后果，包括但不限于账号限制、学习记录清零等。作者不承担任何责任。

## 更新日志

**v1.2** — 白名单跳过逻辑重写、折叠目录自动展开、跨模块连续跳过、web_link等未知类型精准过滤

**v1.1** — 附件预览自动关闭、作业/讨论跳过修复、阅读时间缩短至 5s、移除每日上限

**v1.0** — 首次正式发布

## License

MIT
