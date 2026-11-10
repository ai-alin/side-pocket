# Side Pocket

放在 Chrome 侧边栏里的标签和收藏管理。

- **置顶 / 收藏**：常用网站放在最上面，支持文件夹、颜色、拖拽排序。数据存在 Chrome 书签的「其他书签 / Side Pocket」里，卸载插件也不丢，重装后自动找回。
- **这个窗口**：当前窗口的标签，顺序和 Chrome 标签栏一致，可以点击切换、关闭、拖动排序。
- **一个置顶对应一个标签**：点置顶或收藏，已经开着就切过去，没开才新开；这个标签之后跳到别的网址也还算它的。
- **其他电脑**：你另一台电脑上开着的网页，点一下在这台电脑接着看。可以在设置里关掉上传。
- **搜索**：同时搜标签、收藏和其他电脑的网页。
- **删除可以撤销**：删掉置顶、收藏或文件夹后几秒内可以点「撤销」放回原位。

默认快捷键 `Command+Shift+Y`（Windows / Linux 是 `Ctrl+Shift+Y`），可以在设置里改。

## 本地安装

1. 打开 `chrome://extensions`，打开右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选这个目录。

需要 Chrome 116 或更新的版本。

## 文件

| 文件 | 作用 |
|---|---|
| `sidepanel.html` / `.css` / `.js` | 侧栏界面 |
| `background.js` | 后台：改书签、上传本机清单、升级清理 |
| `model.js` | 置顶和收藏的树形模型 |
| `bookmarks.js` | 书签和侧栏节点之间的换算，删除后撤销 |
| `claims.js` | 置顶 / 收藏和标签的对应关系 |
| `devices.js` | 「其他电脑」的清单格式 |
| `legacy.js` | 0.9.x 及以前的旧数据清理 |

`model.js`、`claims.js`、`devices.js`、`legacy.js` 是纯函数，不依赖 Chrome，可以直接在 node 里测。

## 测试

```sh
npm install
npm test            # 单元测试
npx playwright install chromium
npm run test:e2e    # 端到端测试：用真实 Chromium 加载插件，大约 3 分钟
```

## 打包上架

```sh
npm run pack
```

生成 `dist/side-pocket-<版本号>.zip`，只包含插件运行需要的文件，可以直接上传到 Chrome 应用商店。

`manifest.json` 里的 `key` 只在本地开发时用来固定插件 id，打包时会自动去掉（商店不接受带 `key` 的包）。商店版的插件 id 和本地开发版不一样，所以两者的同步数据（其他电脑的清单、文件夹颜色）互不相通；置顶和收藏在书签里，两边看到的是同一份。

## 数据和隐私

见 [PRIVACY.md](PRIVACY.md)。
