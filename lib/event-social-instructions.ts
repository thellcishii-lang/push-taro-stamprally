// lib/event-social-instructions.ts
// Instagram 投稿キューのセットアップ案内文を組み立てる純粋関数。
//
// 主催者が自分の Muse にそのまま渡せる指示文。管理画面
// （クライアント）から使うため、サーバー専用コードは含めない。
// 案内文には次を含める:
// - キュー確認 API の URL と、連携キーの渡し方（ヘッダ X-Queue-Key）
// - 朝・昼・夜に定期的に確認すること
// - 投稿したら完了 API を呼ぶこと
// キー（平文）は発行直後だけ案内文に差し込める。キーが未発行・再表示
// できない場合はプレースホルダで示し、画面に恒常表示はしない。

export interface SocialQueueEndpoints {
/** キュー確認 API（GET） */
queueUrl: string;
/** 完了 API の URL テンプレート（{postId} を含む） */
postedUrlTemplate: string;
}

/** origin とプロジェクトIDから Muse 用 API の URL 群を組み立てる。 */
export function socialQueueEndpoints(
origin: string,
eventId: string,
): SocialQueueEndpoints {
const base = `${origin.replace(/\/+$/, '')}/api/events/${encodeURIComponent(eventId)}`;
return {
queueUrl: `${base}/social-queue`,
postedUrlTemplate: `${base}/social-queue/{postId}/posted`,
};
}

/**
* 主催者が自分の Muse に渡す指示文を組み立てる（純粋関数）。
* key が null の場合はプレースホルダ（＜発行した連携キー＞）にする。
*/
export function buildSocialQueueInstructions(input: {
endpoints: SocialQueueEndpoints;
key: string | null;
}): string {
const keyPart = input.key?? '＜管理画面で発行した連携キー＞';
return [
'',
'',
'私のプロジェクトの「Instagram投稿キュー」を確認して、たまっている投稿をInstagramに投稿してください。',
'',
'■ 確認のしかた',
`次のURLに、ヘッダ「X-Queue-Key: ${keyPart}」を付けて GET リクエストを送ると、投稿待ちの一覧（JSON）が返ります。`,
input.endpoints.queueUrl,
'一覧の各要素には、投稿ID（id）、本文（text）、写真のURL（photoUrls）が入っています。古い順に並んでいます。',
'',
'■ 投稿のしかた',
'投稿待ちがある場合は、古いものから順に、私のInstagramアカウントへ投稿してください。本文は text をそのまま使い、写真は photoUrls の画像を使ってください。',
'',
'■ 投稿できたら（完了の報告）',
'1件投稿するごとに、次のURLの {postId} を投稿IDに置き換えて POST してください。本文（JSON）には、投稿のURLが分かれば { "postedUrl": "投稿のURL"} を入れてください（無ければ空で構いません）。',
input.endpoints.postedUrlTemplate,
'すでに投稿済みのものに再度呼んでも問題ありません。',
'',
'■ 定期確認のお願い',
'この確認と投稿を、毎日 朝・昼・夜の3回（目安: 9時ごろ・13時ごろ・20時ごろ）、定期実行で回してください。投稿待ちが無いときは何もしないでください。',
'',
'■ 注意',
'連携キーは他人に教えないでください。キーが漏れた可能性がある場合は、管理画面からキーを失効して新しいキーを発行するので、そのときは新しいキーを渡します。',
'キュー確認でエラー（401）になった場合は、キーが失効している可能性があります。その場合は私に知らせてください。',
].join('\n');
}
