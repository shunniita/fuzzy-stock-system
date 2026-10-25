# fuzzy-stock-system

数が分からない物を0にせず、数を確かめた根拠と一緒に残す在庫管理ソフトです。原因が分からない食い違いも、現物を数えて履歴付きで直せます。

小規模な職場や個人が、一台のWindows PCで使います。記録はそのPCのブラウザーに保存します。

## 使い始める

1. [Releases](https://github.com/shunniita/fuzzy-stock-system/releases)から配布ZIPを取得します。
2. ZIPを右クリックし、**すべて展開**を選びます。
3. 展開したフォルダーの`start-local.cmd`をダブルクリックします。
4. **はじめに**の案内に従って、記録する人、場所、品目を登録します。

起動用の黒い画面は開いたまま使います。利用時にNode.jsは不要です。動作確認はWindowsとMicrosoft Edgeで行っています。

[最初の登録から再開までのガイド](manual/01-getting-started.md)で、空の台帳から一通り試せます。[作業別ガイド](manual/02-guide.md)と[困ったときの対処](manual/04-troubleshooting.md)もあります。

## できること

- 品目・場所・案件・用途ごとの在庫と、数の根拠を確認する。
- 使用・移動・分割・統合・取り分け・数え直しを記録する。
- 注文・購入予定、届いた物、製造、やり直し・修理、セットの構成を管理する。
- 履歴を残して訂正し、JSONでバックアップ・復元する。
- 閲覧用のExcelファイルを出力する。

v1.1.0はすべての操作を同じ画面構成で扱います。簡単操作モード、一括取込、工程の設定化は後の版の計画です。詳しい範囲は[製品定義](PRODUCT.md)を参照してください。

## 記録を保管する

同じアドレス・ブラウザー・プロファイルで使います。ブラウザーのデータ削除やプロファイル削除で記録を失うため、**復元用バックアップを保存**でJSONファイルを別に保管してください。Excel出力からは復元できません。

在庫記録は外部へ送信しません。別端末との共有や自動のバックアップはありません。記録する人は一名、操作に使うタブは一つにします。更新時はバックアップを取り、旧版のタブと起動用画面を閉じてから新版を開きます。[保存・復元・更新の手順](manual/04-troubleshooting.md)を参照してください。

## 開発者向け

Node.js 24.21.0、Windows PowerShell、Microsoft Edgeを使います。依存パッケージは固定しています。

```powershell
npm.cmd ci --allow-remote=all
npm.cmd run typecheck
npm.cmd test
npm.cmd run e2e -- --workers=1 --retries=0
npm.cmd run release:check
npm.cmd run release:package
```

`release:package`はコミット済みの入力からZIPを作ります。生成結果に示されたZIPを、`npm.cmd run release:smoke -- <ZIPのパス>`で検証できます。

## ライセンス

[MIT License](LICENSE)で提供し、動作や目的への適合を保証しません。Excel出力に使うSheetJS Community Editionのライセンスは、配布ZIPの`web/dist/vendor/xlsx-LICENSE.txt`に同梱しています。
