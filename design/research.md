# 侧栏设计调研笔记（2026-11-01）

目的：给「Arc 侧边栏」重新设计外观前，看看做得好的侧栏都是怎么处理的，只摘能直接用到我们这个插件上的做法。

| 来源 | 看到了什么 | 我们怎么用 |
|---|---|---|
| Arc 浏览器 | 顶部是图标式「收藏」（约 8 个上限），下面是带名字的固定标签和文件夹，再下面是临时的「今日」标签，带「清除」按钮。每个空间有自己的主题色。 | 区块结构和我们一致，保留。「清除」按钮照搬；主题色的想法用在方案 B。 |
| Linear 2024 改版博客 | 改版目标是减少视觉噪音、对齐、提高导航的层级感和密度。花了大量时间把图标、文字在横竖两个方向对齐。主题只用三个变量生成：底色、强调色、对比度，用 LCH 色彩空间，保证不同颜色看起来一样亮。2026 年又把侧栏调暗一点，让主内容更突出。 | 方案 B 用同样的思路：用户只选一个底色，其余颜色用 oklch 自动算出，深色模式也自动得到。所有图标落在同一竖列。 |
| 苹果 HIG · Sidebars | 层级一般不超过两层；用展开箭头控制层级；图标颜色要有明确含义，克制使用；关键操作不要放在侧栏底部；允许用户隐藏侧栏。macOS 26 的侧栏是浮在内容上、离窗口边缘有间距的 Liquid Glass 面板（macOS 27 又收回到贴边）。 | 文件夹颜色只用于区分文件夹，其他图标保持中性。底部只放同步状态和设置。方案 A 用浮动玻璃面板，因为我们的侧栏本来就浮在网页上。 |
| Zen 浏览器 | 「Essentials」网格 + 工作区；紧凑模式下侧栏隐藏，鼠标移到边缘浮出，新开标签时会短暂闪出。 | 和我们的「完全隐藏」模式一致，浮出时用方案 A 的浮动面板。 |
| Sidebery / zen-tree-tabs（树形标签） | 每一层嵌套一条细引导线，粗细和颜色可调；收起的父级显示里面藏了几项；拖动时横向移动可以改变层级。 | 方案 C 用「├ └」式的拐角连线，最直接地表现从属关系；收起的文件夹显示数量。 |
| Things 3 | 区域用粗体，项目用细一点的字，项目图标是一个随完成度填满的小饼图。 | 方案 C 的文件夹图标做成小饼图，填满的比例 = 里面已打开的网站占比。 |
| Edge / Chrome 标签组 | 标签组可以命名、选颜色、折叠；Chrome 标签组固定 9 种颜色：灰、蓝、红、黄、绿、粉、紫、青、橙。 | 文件夹颜色直接用 Chrome 标签组的 9 色，和浏览器自己的标签组看起来是一套。 |
| Dia 浏览器 | 设计负责人（前 Safari 设计负责人）的原则是让任何人「周二早上 10 点就能直接换过来用」，侧栏功能做得克制，可以一键隐藏。 | 新外观不加学习成本：已有操作位置不变。 |
| Mobbin 侧栏案例库 | 1700 多个真实产品的侧栏：抽屉式、收起成图标栏（悬停出提示）、手风琴式。提醒图标栏虽然快，但容易信息过载。 | 收起后的图标栏保留，但只放置顶和当前相关的图标，不堆满所有收藏。 |

## 结论

1. 层级靠缩进 + 引导线表达，不靠颜色和字号硬撑。
2. 颜色只给「有含义」的东西：文件夹颜色、已打开的状态点。
3. 主题用少量变量生成，浅色、深色、不同底色都自动协调。
4. 我们的侧栏浮在网页上，浮动面板比贴边更合理。

## 来源

- Linear：[How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)、[Welcome to the new Linear](https://linear.app/changelog/2024-03-20-new-linear-ui)、[Personalized sidebar](https://linear.app/changelog/2024-12-18-personalized-sidebar)、[UI refresh 2026](https://linear.app/changelog/2026-03-12-ui-refresh)
- 苹果：[HIG Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[WWDC25 SwiftUI 新设计](https://developer.apple.com/videos/play/wwdc2025/323/)、[AppleInsider：macOS 27 的 Liquid Glass](https://appleinsider.com/articles/26/06/09/dont-get-excited-for-big-liquid-glass-changes-in-macos-27-because-they-arent-there)
- Arc：[Zapier 评测](https://zapier.com/blog/arc-browser-review/)、[The Sweet Setup](https://thesweetsetup.com/first-look-arc-browser/)、[MakeUseOf](https://www.makeuseof.com/features-arc-browser/)
- Zen：[官网](https://zen-browser.app/)、[MakeUseOf](https://www.makeuseof.com/stopped-organizing-tabs-zen-showed-what-browsers-do/)
- 树形标签：[zen-tree-tabs](https://github.com/tworekj/zen-tree-tabs)、[Sidebery 介绍](https://dev.to/weatherclockdash/sidebery-vertical-tab-sidebar-for-firefox-with-tree-structure-and-session-snapshots-59lh)
- Things 3：[Cultured Code](https://culturedcode.com/things/features/)、[MacStories 评测](https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/)、[Pratt 设计评析](https://ixd.prattsi.org/2020/02/design-critique-things-3-ios-app/)
- Edge / Chrome：[gHacks](https://www.ghacks.net/2021/07/02/tab-groups-in-microsoft-edge-work-better-thanks-to-vertical-tabs/)、[Chrome tabGroups API](https://developer.chrome.com/docs/extensions/reference/tabGroups)
- Dia：[Thurrott](https://www.thurrott.com/cloud/web-browsers/322287/the-browser-company-explains-its-vision-for-dia)、[TechCrunch](https://techcrunch.com/2025/11/03/dias-ai-browser-starts-adding-arcs-greatest-hits-to-its-feature-set)
- 案例库：[Mobbin 侧栏](https://mobbin.com/glossary/sidebar)、[Mobbin Web 侧边导航](https://mobbin.com/explore/web/ui-elements/side-navigation)
