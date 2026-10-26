// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 yksr-melt
import test from 'node:test';
import assert from 'node:assert/strict';
import { decision, excessPulls, githubApi, Labels, runPolicy, WaitMs } from './policy.mjs';

const start = Date.parse('2026-10-25T00:00:00Z');
const user = login => ({ login, type: 'User' });
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const issue = (number, labels = [], author = 'alice') => ({
  number, state: 'open', user: user(author), body: '報告', labels: labels.map(name => ({ name })),
  created_at: new Date(start - WaitMs * 2 + number * 1000).toISOString(),
});
const pull = (number, draft = false, author = 'alice') => ({
  ...issue(number, [], author), draft, head: { sha: 'original' }, pull_request: {},
});

/** インメモリの GitHub API。API の書き込みまで通して、閉じる対象とタイミングを確かめる。 */
function fixture(items) {
  const records = new Map(items.map(i => [i.number, structuredClone(i)]));
  const comments = new Map(items.map(i => [i.number, []]));
  const events = new Map(items.map(i => [i.number, []]));
  const reviewComments = new Map(items.map(i => [i.number, []]));
  const reviews = new Map(items.map(i => [i.number, []]));
  const writes = [];
  let serial = 1, now = start;
  const api = {
    async list(path) {
      if (path.startsWith('/pulls?')) return structuredClone([...records.values()].filter(i => i.pull_request && i.state === 'open'));
      if (path === '/labels') return Object.values(Labels).map(name => ({ name }));
      if (path.startsWith('/issues?')) return structuredClone([...records.values()].filter(i => i.state === 'open' && i.labels.some(l => l.name === Labels.info)));
      const reviewMatch = path.match(/^\/pulls\/(\d+)\/(comments|reviews)$/);
      if (reviewMatch) return structuredClone((reviewMatch[2] === 'reviews' ? reviews : reviewComments).get(+reviewMatch[1]));
      const [, n, collection] = path.match(/^\/issues\/(\d+)\/(comments|events)$/) ?? [];
      if (!n) throw new Error(`未対応の一覧: ${path}`);
      return structuredClone((collection === 'comments' ? comments : events).get(+n));
    },
    async request(method, path, body) {
      if (method !== 'GET') writes.push({ method, path, body });
      const commentMatch = path.match(/^\/issues\/comments\/(\d+)$/);
      if (commentMatch) {
        for (const list of comments.values()) {
          const comment = list.find(c => c.id === +commentMatch[1]);
          if (comment) { Object.assign(comment, body); return structuredClone(comment); }
        }
        throw new Error('コメントがない');
      }
      const [, n, collection, value] = path.match(/^\/(?:issues|pulls)\/(\d+)(?:\/(comments|labels)(?:\/(.+))?)?$/) ?? [];
      const item = records.get(+n);
      if (!item) throw new Error(`対象がない: ${path}`);
      if (method === 'GET') return structuredClone(item);
      if (collection === 'comments') {
        const comment = { id: serial++, user: bot, body: body.body, created_at: new Date(now).toISOString() };
        comments.get(+n).push(comment);
        return structuredClone(comment);
      }
      if (collection === 'labels') {
        if (method === 'POST') {
          for (const name of body.labels) if (!item.labels.some(l => l.name === name)) {
            item.labels.push({ name }); addEvent(+n, 'labeled', name);
          }
        } else {
          const name = decodeURIComponent(value);
          item.labels = item.labels.filter(l => l.name !== name);
          addEvent(+n, 'unlabeled', name);
        }
      } else Object.assign(item, body);
      return structuredClone(item);
    },
  };
  function addEvent(n, event, label) {
    events.get(n).push({ id: serial++, event, label: { name: label }, created_at: new Date(now).toISOString() });
  }
  return {
    api, records, comments, events, reviewComments, reviews, writes, addEvent,
    async run(time = start, eventName = 'schedule', event = {}) { now = time; await runPolicy(api, event, eventName, now); },
    reply(n, author = 'alice', time = start + 1000) {
      comments.get(n).push({ id: serial++, user: user(author), body: '確認します', created_at: new Date(time).toISOString() });
    },
  };
}

test('Draft は上限に含めず、作者ごとの古い 2 件を残す', () => {
  assert.deepEqual([...excessPulls([pull(4), pull(1, true), pull(3), pull(2), pull(5, false, 'bob')])], [4]);
});

test('3 件目だけに通知し、通知後 14 日でその PR だけを閉じる', async () => {
  const f = fixture([pull(1), pull(2), pull(3)]);
  await f.run();
  assert.equal(f.comments.get(1).length, 0);
  assert.equal(f.comments.get(3).length, 1);
  await f.run(start + WaitMs - 1);
  assert.equal(f.records.get(3).state, 'open');
  await f.run(start + WaitMs);
  assert.equal(f.records.get(3).state, 'closed');
  assert.equal(f.records.get(1).state, 'open');
  assert.equal(f.records.get(2).state, 'open');
});

test('投稿者の返信後は、長期間たっても自動クローズしない', async () => {
  const f = fixture([pull(1), pull(2), pull(3)]);
  await f.run();
  f.reply(3);
  await f.run(start + WaitMs);
  await f.run(start + WaitMs * 3);
  assert.equal(f.records.get(3).state, 'open');
  assert.match(f.comments.get(3)[0].body, /自動クローズを止め/);
});

test('他の人・bot のコメントやレビュー通知では投稿者の返信とみなさない', async () => {
  const f = fixture([pull(1), pull(2), pull(3)]);
  await f.run();
  f.reply(3, 'reviewer');
  f.comments.get(3).push({ user: bot, body: 'CI 成功', created_at: new Date(start + 1000).toISOString() });
  await f.run(start + WaitMs);
  assert.equal(f.records.get(3).state, 'closed');
});

for (const change of ['push', 'body', 'draft', 'slot']) {
  test(`${change}: 対応・Draft 化・空き枠で超過 PR を閉じない`, async () => {
    const f = fixture([pull(1), pull(2), pull(3)]);
    await f.run();
    if (change === 'push') f.records.get(3).head.sha = 'new';
    if (change === 'body') f.records.get(3).body += '追記';
    if (change === 'draft') f.records.get(3).draft = true;
    if (change === 'slot') f.records.get(1).state = 'closed';
    await f.run(start + WaitMs);
    assert.equal(f.records.get(3).state, 'open');
    if (['draft', 'slot'].includes(change)) assert.equal(f.records.get(3).labels.length, 0);
  });
}

test('手動の PR要対応ラベルも通知から 14 日待ち、通知を重複投稿しない', async () => {
  const pr = pull(1); pr.labels = [{ name: Labels.rule }];
  const f = fixture([pr]);
  await f.run(); await f.run(start + 1000);
  assert.equal(f.comments.get(1).length, 1);
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'closed');
});

test('情報待ちも、古い Issue を即座に閉じず初回通知から 14 日待つ', async () => {
  const f = fixture([issue(1, [Labels.info]), issue(2)]);
  await f.run();
  assert.equal(f.records.get(1).state, 'open');
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'closed');
  assert.equal(f.records.get(2).state, 'open');
});

test('情報待ちへの返信と本文追記で、メンテナーの確認待ちにする', async () => {
  const f = fixture([issue(1, [Labels.info]), issue(2, [Labels.info])]);
  await f.run(); f.reply(1); f.records.get(2).body += '情報';
  await f.run(start + WaitMs * 2);
  assert.equal(f.records.get(1).state, 'open');
  assert.equal(f.records.get(2).state, 'open');
});

test('ラベル解除で期限管理を止め、付け直すと新しく 14 日待つ', async () => {
  const f = fixture([issue(1, [Labels.info])]);
  await f.run();
  f.records.get(1).labels = [];
  f.addEvent(1, 'unlabeled', Labels.info);
  await f.run(start + WaitMs, 'issues', { issue: { number: 1 } });
  assert.match(f.comments.get(1)[0].body, /対象ではなく/);
  f.records.get(1).labels = [{ name: Labels.info }];
  f.addEvent(1, 'labeled', Labels.info);
  await f.run(start + WaitMs * 2);
  assert.equal(f.records.get(1).state, 'open');
  await f.run(start + WaitMs * 3);
  assert.equal(f.records.get(1).state, 'closed');
});

test('再オープン時は、古い通知の期限で即クローズしない', async () => {
  const f = fixture([issue(1, [Labels.info])]);
  await f.run(); await f.run(start + WaitMs);
  f.records.get(1).state = 'open'; f.addEvent(1, 'reopened');
  await f.run(start + WaitMs * 2);
  assert.equal(f.records.get(1).state, 'open');
});

test('イベント処理は通知だけで、期限切れでもクローズしない', async () => {
  const f = fixture([issue(1, [Labels.info])]);
  await f.run();
  await f.run(start + WaitMs, 'issues', { issue: { number: 1 } });
  assert.equal(f.records.get(1).state, 'open');
});

test('閉じる直前の再取得で返信が見つかったら閉じない', async () => {
  const f = fixture([issue(1, [Labels.info])]);
  await f.run();
  const original = f.api.list; let reads = 0;
  f.api.list = async path => {
    if (path === '/issues/1/comments' && ++reads === 2) f.reply(1);
    return original(path);
  };
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'open');
});

test('ユーザーが通知マーカーを偽装しても、期限切れとして扱わない', async () => {
  const f = fixture([issue(1, [Labels.info])]);
  await f.run();
  f.comments.get(1)[0].user = user('attacker');
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'open');
  assert.equal(f.comments.get(1).length, 2);
});

test('API の 2 ページ目まで読む。API エラー時は欠けた一覧を返さない', async () => {
  const calls = [];
  const api = githubApi({ token: 'test', repository: 'test/repo', fetcher: async url => {
    calls.push(url);
    return { ok: true, json: async () => url.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ number: i })) : [{ number: 100 }] };
  } });
  assert.equal((await api.list('/pulls?state=open')).length, 101);
  assert.equal(calls.length, 2);
  const failing = githubApi({ token: 'test', repository: 'test/repo', fetcher: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(failing.list('/pulls'), /403/);
});

test('Draft からレビューへ戻したら、手動ルールの古い期限を引き継がない', async () => {
  const pr = pull(1); pr.labels = [{ name: Labels.rule }];
  const f = fixture([pr]); await f.run();
  f.addEvent(1, 'converted_to_draft'); f.addEvent(1, 'ready_for_review');
  await f.run(start + WaitMs * 2);
  assert.equal(f.records.get(1).state, 'open');
});

test('壊れた通知はクローズの根拠にしない', async () => {
  const f = fixture([issue(1, [Labels.info])]); await f.run();
  f.comments.get(1)[0].body = f.comments.get(1)[0].body.replace(/"since":"[^"]+"/, '"since":"invalid"');
  assert.equal(decision(f.records.get(1), 'info', f.comments.get(1), [], start + WaitMs).action, 'warn');
});

for (const kind of ['reviewComments', 'reviews']) {
  test(`${kind}: 投稿者のレビュー内の返信でも自動クローズを止める`, async () => {
    const pr = pull(1); pr.labels = [{ name: Labels.rule }];
    const f = fixture([pr]); await f.run();
    f[kind].get(1).push({ user: user('alice'), body: '修正しました',
      created_at: new Date(start + 1000).toISOString(), submitted_at: new Date(start + 1000).toISOString() });
    await f.run(start + WaitMs);
    assert.equal(f.records.get(1).state, 'open');
  });
}

test('昔のコメントを編集した返信も拾う', async () => {
  const f = fixture([issue(1, [Labels.info])]);
  f.reply(1, 'alice', start - 1000); await f.run();
  f.comments.get(1)[0].updated_at = new Date(start + 1000).toISOString();
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'open');
});

test('フォームなど bot 名義の報告は、人からの補足でも待機を止める', async () => {
  const report = issue(1, [Labels.info]); report.user = bot;
  const f = fixture([report]); await f.run(); f.reply(1, 'reporter');
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'open');
});

test('閉じる直前に空き枠ができた場合も PR を閉じない', async () => {
  const f = fixture([pull(1), pull(2), pull(3)]); await f.run();
  const original = f.api.list; let reads = 0;
  f.api.list = async path => {
    if (path === '/pulls?state=open' && ++reads === 2) f.records.get(1).state = 'closed';
    return original(path);
  };
  await f.run(start + WaitMs);
  assert.equal(f.records.get(3).state, 'open');
});

test('情報待ちラベルを解除していれば期限切れでも閉じない', async () => {
  const f = fixture([issue(1, [Labels.info])]); await f.run();
  const original = f.api.request; let reads = 0;
  f.api.request = async (method, path, body) => {
    if (method === 'GET' && path === '/issues/1' && ++reads === 2) f.records.get(1).labels = [];
    return original(method, path, body);
  };
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'open');
});

test('API 取得に失敗したら、自動クローズせずに異常終了する', async () => {
  const f = fixture([issue(1, [Labels.info])]); await f.run();
  const original = f.api.list;
  f.api.list = async path => {
    if (path === '/issues/1/events') throw new Error('rate limit');
    return original(path);
  };
  await assert.rejects(f.run(start + WaitMs), /rate limit/);
  assert.equal(f.records.get(1).state, 'open');
});

test('通知の投稿が遅れた場合も、実際の通知から丸 14 日待つ', async () => {
  const f = fixture([issue(1, [Labels.info])]); await f.run();
  f.comments.get(1)[0].created_at = new Date(start + 60_000).toISOString();
  await f.run(start + WaitMs);
  assert.equal(f.records.get(1).state, 'open');
  await f.run(start + WaitMs + 60_000);
  assert.equal(f.records.get(1).state, 'closed');
});
