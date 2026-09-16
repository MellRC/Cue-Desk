# CueDesk

CueDesk 是一个本地 HTML 演示工具。它支持演讲备注、双屏投放、下一页预览和演示计时。

## 安装

下载并运行 `CueDesk-Setup-1.0.0.exe`。安装程序会创建桌面和开始菜单快捷方式。

## 使用

1. 启动 CueDesk。
2. 导入一份 HTML 演示文件。
3. 在讲稿编辑中添加每页备注。
4. 连接扩展屏后，切换到投屏播放。

投屏前，请在 Windows 显示设置中选择“扩展这些显示器”。

## 开发

需要 Node.js 20 或更高版本。

```powershell
npm install
npm start
```

生成 Windows 安装包：

```powershell
npm run dist
```

安装包会输出到 `release` 目录。

## 许可

MIT
