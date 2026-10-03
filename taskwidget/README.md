# TaskWidget

デスクトップに常駐させる軽量タスクウィジェット(Tauri v2 / Windows向け)。

- 表示モード切替: 常に最前面 / デスクトップ固定(最背面) / 通常(⚙から)
- 枠なし・半透明、ヘッダーをドラッグで移動、縁でリサイズ。位置・サイズは記憶
- タスク: Enterで追加、ダブルクリックで編集、チェックで完了(下に移動)、🧹で完了済み削除
- Windows起動時の自動起動(⚙から)

## ビルド
GitHub Actions「Build TaskWidget (Windows)」を実行し、Artifactsから exe / インストーラを取得。
ローカル: `npm install && npx tauri icon app-icon.png && npx tauri build`(要 Rust)
