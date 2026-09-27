# JavaScriptファイル分割 TODO

## 目的

`app.js`に集まっているデータ処理、表示テスト、画面制御を責務ごとに分け、変更箇所を追いやすくする。

分割後も、ビルドやローカルサーバーを必要とせず、`index.html`を直接開いて利用できる状態を維持する。

## 完成時の構成

`index.html`から、次の順番で通常の`script`タグを使って読み込む。

```html
<script src="core.js"></script>
<script src="display-test.js"></script>
<script src="app.js"></script>
```

- `core.js`: JSON検証、Gyazo URL抽出、一覧計算、結果定義、CSV生成などの純粋な処理
- `display-test.js`: `i.gyazo.com`のメディア読み込み、タイムアウト、キャンセル、判定結果の生成
- `app.js`: 画面状態、DOM操作、保存、一括実行、ファイル読み込み、イベント登録

ES Modulesの`import`は使用しない。各ファイルをIIFEで囲み、必要な機能だけを`window`上の名前空間へ公開する。

## 共通ルール

- 1コミットでは、記載された責務の移動以外の機能変更やUI変更を行わない。
- 各コード変更と同じコミットで、`docs/spec_changes.md`へ日本語の変更記録を追加する。
- 現在の`window.CosenseGyazoReview`テスト用APIは維持する。
- JSON由来の値を`innerHTML`で表示しない方針を維持する。
- 実際のCosenseエクスポートJSONや、抽出した実在のURL・本文をコミットしない。
- 各コミット後に`index.html`を直接開き、単独で利用できることを確認する。
- 改行、タブ、インデント、不要なエスケープ文字と`git diff --check`を確認する。

## コミット1: データ処理を`core.js`へ分離する

コミットメッセージ案:

`【リファクタリング】JSON解析と一覧計算をcore.jsへ分離`

対象ファイル:

- 新規: `core.js`
- 変更: `app.js`
- 変更: `index.html`
- 変更: `docs/spec_changes.md`

作業:

- [ ] `core.js`をIIFEとして作成する。
- [ ] `core.js`の先頭に担当範囲を示すコメントと、内部処理に必要なJSDoc型定義を記載する。
- [ ] 次の定数と関数を`app.js`から`core.js`へ移す。
  - `GYAZO_PATTERN`
  - `validateExport()`
  - `getCosensePageUrl()`
  - `extractImages()`
  - `filterImages()`
  - `paginateImages()`
- [ ] 公開する機能を`window.CosenseGyazoReviewCore`へまとめ、`Object.freeze()`する。
- [ ] `app.js`では`window.CosenseGyazoReviewCore`から必要な機能を取得する。
- [ ] `index.html`で`core.js`を`app.js`より先に読み込む。
- [ ] `window.CosenseGyazoReview`から公開している既存関数を引き続き利用できるようにする。
- [ ] `app.js`の画面状態や描画処理で参照するJSDoc型定義は、同ファイル内に残す。
- [ ] 移動元に定義や定数が重複して残っていないことを確認する。
- [ ] `docs/spec_changes.md`へ分離内容を記録する。

確認:

- [ ] 正常なテスト用JSONを読み込める。
- [ ] 不正なJSON形式では従来どおり日本語のエラーを表示する。
- [ ] Gyazo画像IDの抽出と重複除去結果が変わらない。
- [ ] 掲載元ページと該当行が従来どおり表示される。
- [ ] 検索、結果絞り込み、ページ分割が動作する。
- [ ] `index.html`を`file://`で直接開いて利用できる。

## コミット2: 結果定義とCSV処理を`core.js`へ分離する

コミットメッセージ案:

`【リファクタリング】表示結果定義とCSV生成をcore.jsへ分離`

対象ファイル:

- 変更: `core.js`
- 変更: `app.js`
- 変更: `docs/spec_changes.md`

作業:

- [ ] 表示テスト結果に関する設定を`core.js`へ移す。
  - `DISPLAY_TEST_RESULT_CONFIG`
  - `DISPLAY_TEST_SUMMARY_KEYS`
  - `DISPLAY_TEST_OUTCOME_KEYS`
  - `DISPLAY_FORMATS`
- [ ] 次の結果処理を`core.js`へ移す。
  - `getDisplayTestResultDefinition()`
  - `isStoredDisplayTestResult()`
  - `createResultCounts()`
  - `isValidDisplayTestResult()`
- [ ] 次のCSV定数と処理を`core.js`へ移す。
  - `CSV_HEADER`
  - `CSV_FORMULA_PREFIX_PATTERN`
  - `sanitizeCsvCell()`
  - `csvEscape()`
  - `createCsvRows()`
  - `createCsvText()`
- [ ] DOMとBlobを扱う`downloadCsv()`と`exportCsv()`は`app.js`に残す。
- [ ] 各ファイルのJSDocで必要な表示テスト結果型を、そのファイル内に定義する。
- [ ] 既存の`window.CosenseGyazoReview`テスト用APIを同じ名前で維持する。
- [ ] 移動元に定義や定数が重複して残っていないことを確認する。
- [ ] `docs/spec_changes.md`へ分離内容を記録する。

確認:

- [ ] 保存済みの「表示できた」「表示できない」「時間切れ」を復元できる。
- [ ] 不正な保存値を従来どおり除外する。
- [ ] 結果別件数と絞り込み結果が変わらない。
- [ ] CSVの列、表示ラベル、検査日時、掲載元ページが変わらない。
- [ ] CSVがUTF-8 BOM付き、CRLF区切りで生成される。
- [ ] `=`、`+`、`-`、`@`、タブ、改行で始まるCSVセルが無害化される。

## コミット3: メディア判定を`display-test.js`へ分離する

コミットメッセージ案:

`【リファクタリング】メディア表示判定をdisplay-test.jsへ分離`

対象ファイル:

- 新規: `display-test.js`
- 変更: `app.js`
- 変更: `index.html`
- 変更: `docs/spec_changes.md`

作業:

- [ ] `display-test.js`をIIFEとして作成する。
- [ ] `core.js`が公開する`DISPLAY_FORMATS`を利用する。
- [ ] `display-test.js`の先頭に担当範囲を示すコメントと、内部処理に必要なJSDoc型定義を記載する。
- [ ] 次の定数と関数を`app.js`から`display-test.js`へ移す。
  - `TEST_TIMEOUT_MS`
  - `getDisplayImageUrl()`
  - `createMediaTest()`
- [ ] リクエスト識別子の採番を`display-test.js`内へ移し、結果と一緒に`requestId`を返す。
- [ ] 公開する機能を`window.CosenseGyazoReviewDisplayTest`へまとめ、`Object.freeze()`する。
- [ ] `app.js`では`window.CosenseGyazoReviewDisplayTest`から必要な機能を取得する。
- [ ] `app.js`で結果を受け取る処理に必要な`MediaTestOutcome`のJSDoc型定義は残す。
- [ ] `AppState`から不要になった`requestSequence`を削除する。
- [ ] `index.html`で`display-test.js`を`core.js`の後、`app.js`の前に読み込む。
- [ ] 状態保存、画面更新、一括ワーカーは`app.js`に残す。
- [ ] 移動元にメディア読込処理が重複して残っていないことを確認する。
- [ ] `docs/spec_changes.md`へ分離内容を記録する。

確認:

- [ ] PNG・JPG・GIF・MP4のいずれかを読み込めた場合に「表示できた」となる。
- [ ] 全形式が失敗した場合に「表示できない」となる。
- [ ] 応答がない場合に「時間切れ」となる。
- [ ] 再テスト時にキャッシュ回避用クエリが付く。
- [ ] 個別テスト、再テスト、一括テストが動作する。
- [ ] 一括テストを停止できる。
- [ ] テスト中に別のJSONを読み込んでも古い結果が混入しない。
- [ ] 表示できた画像または動画のプレビューを確認できる。

## コミット4: ファイル境界と文書を仕上げる

コミットメッセージ案:

`【ドキュメント】JavaScriptファイルの責務と読込順を明記`

対象ファイル:

- 変更: `README.md`

作業:

- [ ] READMEへ3ファイルの責務と読み込み順を簡潔に記載する。
- [ ] 各ファイルの先頭コメントに担当範囲が記載されていることを確認する。
- [ ] 名前空間に公開している値が必要最小限か確認する。
- [ ] `app.js`に純粋なデータ処理やメディア読込処理が残っていないか確認する。
- [ ] `core.js`と`display-test.js`がDOMの画面要素を直接更新していないことを確認する。
- [ ] `window.CosenseGyazoReview`の既存テスト用APIが維持されていることを確認する。

最終確認:

- [ ] `index.html`を直接開き、JSON読込からCSV出力まで一連の操作を確認する。
- [ ] Bootstrap CDNの読み込みに失敗しても主要操作を利用できる。
- [ ] JSON本文、ページ名、行テキスト、画像ID、検索語、表示結果を解析イベントへ送信していない。
- [ ] 実際のエクスポートJSONでは件数だけを確認し、内容やURLをリポジトリへ残していない。
- [ ] `git diff --check`が成功する。
- [ ] 変更ファイルにタブ、改行崩れ、インデントずれ、不要なエスケープ文字がない。
