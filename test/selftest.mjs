// 无依赖自测：用 stub ctx 验证路由、命令与状态机（不联网，fetch 被替换）。

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply, name, inject } from '../lib/index.js';

const dir = mkdtempSync(path.join(tmpdir(), 'repo-watcher-'));
process.env.DSH_REPO_WATCHER_HOME = dir;

let route = null;
let command = null;
const ctx = {
  effect(fn) {
    const dispose = fn();
    return dispose;
  },
  webServer: {
    register(def) {
      route = def;
    },
  },
  commands: {
    register(def) {
      command = def;
    },
  },
};

function call(method, url, body) {
  return new Promise((resolve) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const listeners = {};
    const req = {
      method,
      url,
      on(ev, fn) {
        listeners[ev] = fn;
        return req;
      },
    };
    const res = {
      status: 0,
      headers: null,
      body: "",
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(text) {
        this.body = text || "";
        resolve({ status: this.status, body: this.body, headers: this.headers });
      },
    };
    queueMicrotask(() => {
      if (payload && listeners.data) listeners.data(Buffer.from(payload));
      if (listeners.end) listeners.end();
    });
    route.handler(req, res);
  });
}

const issues = [
  {
    id: 11,
    number: 7,
    title: "支持 Gitee 仓库",
    state: "open",
    user: { login: "alice" },
    html_url: "https://github.com/octo/demo/issues/7",
    updated_at: "2026-11-11T08:00:00Z",
    created_at: "2026-11-10T08:00:00Z",
  },
  {
    id: 12,
    number: 9,
    title: "Fix polling",
    state: "open",
    pull_request: { url: "x" },
    user: { login: "bob" },
    html_url: "https://github.com/octo/demo/pull/9",
    updated_at: "2026-11-11T09:00:00Z",
    created_at: "2026-11-11T09:00:00Z",
  },
];

class FakeHeaders {
  constructor(map) {
    this.map = map;
  }
  get(k) {
    return this.map.get(k) || null;
  }
}

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return {
    status: 200,
    ok: true,
    headers: new FakeHeaders(
      new Map([
        ["etag", '"abc"'],
        ["x-ratelimit-remaining", "59"],
      ])
    ),
    json: async () => issues,
  };
};
const origFetch = globalThis.fetch;

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log('  ✓', label);
  else {
    console.error('  ✗', label);
    failed += 1;
  }
};

async function main() {
  ok(name === 'repo-watcher', 'name');
  ok(inject.includes('webServer') && inject.includes('commands'), 'inject');

  apply(ctx, { dataDir: dir });
  ok(route && route.kind === 'prefix' && route.path === '/repo-watcher', '注册路由 /repo-watcher');
  ok(command && command.name === 'watch', '注册命令 /watch');

  let r = await call('GET', '/repo-watcher/api/state');
  ok(r.status === 200 && JSON.parse(r.body).repos.length === 0, '初始状态为空');

  r = await call('POST', '/repo-watcher/api/repos', { slug: 'octo/demo' });
  let st = JSON.parse(r.body);
  ok(r.status === 200, '添加仓库 200');
  ok(st.repos.length === 1 && st.repos[0].slug === 'octo/demo', '仓库已保存');
  ok(st.repos[0].items.length === 2, '抓到 2 条 issue/PR');
  ok(st.repos[0].items[1].type === 'pr', 'PR 类型识别');
  ok(st.unread === 0, '首次抓取作为基线，不算未读');

  issues[0].updated_at = '2026-11-11T10:00:00Z';
  r = await call('POST', '/repo-watcher/api/check', { slug: 'octo/demo' });
  ok(JSON.parse(r.body).unread === 1, '状态变化后产生 1 条未读');

  r = await call('POST', '/repo-watcher/api/read', {});
  ok(JSON.parse(r.body).unread === 0, '全部已读生效');

  const out = await command.handler('list');
  ok(out.kind === 'success' && out.text.includes('octo/demo'), '/watch list 可用');

  const bad = await command.handler('add not-a-slug');
  ok(bad.kind === 'error', '非法仓库名被拒');

  const statePath = path.join(dir, 'state.json');
  ok(existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).repos['octo/demo'], '状态落盘');

  r = await call('POST', '/repo-watcher/api/remove', { slug: 'octo/demo' });
  ok(JSON.parse(r.body).repos.length === 0, '移除生效');

  ok(fetchCalls >= 1, '走了 fetch');

  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = origFetch;
  if (failed) {
    console.error(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
