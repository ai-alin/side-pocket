# 图标源文件

Side Pocket 的图标：一张网页插在口袋里，主色 `#5393FF`。

| 文件 | 用在哪 |
|---|---|
| `pocket.svg` | 完整版（带纸上的线、投影、高光）。`icons/icon128.png` 和 `icons/icon48.png` 由它渲染 |
| `pocket-small.svg` | 小尺寸版：按 16×16 的像素格画，去掉了纸上的线和投影，描边正好 1 像素。`icons/icon16.png` 和 `icons/icon32.png` 由它渲染 |

完整版是用 [kubai-icons](https://github.com/kubai087/kubai-icons) 的引擎画出来再导出的静态 SVG（按它的许可证，产出归使用者所有）。

要重新出 PNG：在浏览器里把 SVG 按目标像素大小渲染后截图，背景透明。完整版渲染时把 `viewBox` 改成以 (15.5, 12.5) 为中心的正方形，128px 边长取 31 个单位，48px 取 30。
