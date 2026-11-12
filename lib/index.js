// dsh-repo-watcher — host half.
//
// 盯住你关心的 GitHub 仓库：新的 issue / PR、或已有条目状态变化时记下来，
// 在「设置 → 仓库雷达」里显示未读；也可用 /watch 命令查看。
// 零依赖，只用内置 fetch 与 node:fs。

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const name = 'repo-watcher';
export const inject = ['webServer', 'commands'];

const PREFIX = '/repo-watcher';
const API = 'https://api.github.com';
const GITEE_API = 'https://gitee.com/api/v5';
const UA = 'dsh-repo-watcher/0.1.1';
const MAX_ITEMS = 100;
const DEFAULT_INTERVAL = 10;

function resolveDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim()) {
    return path.resolve(config.dataDir);
  }
  if (process.env.DSH_REPO_WATCHER_HOME) return path.resolve(process.env.DSH_REPO_WATCHER_HOME);
  return path.join(homedir(), '.dsh', 'repo-watcher');
}

function emptyState() {
  return { version: 1, settings: { intervalMinutes: DEFAULT_INTERVAL }, repos: {} };
}

function loadState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const state = emptyState();
    if (raw && typeof raw === 'object') {
      if (raw.settings && Number.isFinite(raw.settings.intervalMinutes)) {
        state.settings.intervalMinutes = clampInterval(raw.settings.intervalMinutes);
      }
      if (raw.repos && typeof raw.repos === 'object') state.repos = raw.repos;
    }
    return state;
  } catch {
    return emptyState();
  }
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function clampInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
  return Math.min(120, Math.max(5, Math.round(n)));
}

const SLUG_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

function validSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s.trim());
}

// 认 owner/repo、github.com/owner/repo、gitee.com/owner/repo、gitee:owner/repo。
// key 就是 state.repos 的键：GitHub 不带前缀（兼容旧 state.json 里的键）。
function parseRef(input) {
  let s = String(input == null ? '' : input).trim();
  let provider = 'github';
  const m = /^https?:\/\/(github\.com|gitee\.com)\/(.+)$/i.exec(s);
  if (m) {
    provider = m[1].toLowerCase() === 'gitee.com' ? 'gitee' : 'github';
    s = m[2];
  } else if (/^gitee:/i.test(s)) {
    provider = 'gitee';
    s = s.slice(6);
  } else if (/^github:/i.test(s)) {
    provider = 'github';
    s = s.slice(7);
  }
  s = s.replace(/[?#].*$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const slug = s.split('/').filter(Boolean).slice(0, 2).join('/');
  return {
    provider,
    slug,
    key: provider === 'gitee' ? `gitee:${slug}` : slug,
    ok: validSlug(slug),
  };
}

function normalizeSlug(s) {
  return parseRef(s).key;
}

function repoUrl(repo) {
  const host = repo.provider === 'gitee' ? 'gitee.com' : 'github.com';
  return `https://${host}/${repo.slug}`;
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function ago(ts) {
  if (!ts) return '还没检查过';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  const stateFile = path.join(dataDir, 'state.json');
  const state = loadState(stateFile);
  // 旧 state.json 里的条目没有 key / provider，补上（GitHub 的 key 就是 slug）。
  if (state.repos && typeof state.repos === 'object') {
    for (const [k, r] of Object.entries(state.repos)) {
      if (!r || typeof r !== 'object') continue;
      if (!r.key) r.key = r.slug || k;
      if (!r.provider) r.provider = String(r.key).startsWith('gitee:') ? 'gitee' : 'github';
      if (!r.slug) r.slug = String(r.key).replace(/^gitee:/, '');
    }
  }
  const token = (config.token || process.env.GITHUB_TOKEN || '').trim();
  const giteeToken = (config.giteeToken || process.env.GITEE_TOKEN || '').trim();

  let timer = null;
  let polling = false;

  const persist = () => saveState(stateFile, state);

  function publicState() {
    const repos = Object.values(state.repos)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .map((r) => ({
        slug: r.slug,
        provider: r.provider || 'github',
        url: repoUrl(r),
        unread: (r.items || []).filter((i) => !i.read).length,
        error: r.error || null,
        lastPolledAt: r.lastPolledAt || null,
        lastPolledText: ago(r.lastPolledAt),
        items: (r.items || []).slice(0, 30),
      }));
    return {
      settings: { intervalMinutes: state.settings.intervalMinutes },
      repos,
      unread: repos.reduce((n, r) => n + r.unread, 0),
      dataDir,
      hasToken: Boolean(token),
      hasGiteeToken: Boolean(giteeToken),
    };
  }

  async function github(url, etag) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': UA };
    if (etag) headers['if-none-match'] = etag;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    return res;
  }

  // Gitee v5 的 token 走 query；私有仓库靠它才能读。
  async function gitee(pathname, params = {}, etag) {
    const q = new URLSearchParams(params);
    if (giteeToken) q.set('access_token', giteeToken);
    const headers = { accept: 'application/json', 'user-agent': UA };
    if (etag) headers['if-none-match'] = etag;
    const res = await fetch(`${GITEE_API}${pathname}?${q.toString()}`, { headers });
    return res;
  }

  function giteeError(res) {
    if (res.status === 401 || res.status === 403) {
      return giteeToken
        ? `Gitee 拒绝请求（HTTP ${res.status}，token 可能过期或无这个仓库的权限）`
        : 'Gitee 需要 token（私有仓库请配 giteeToken / GITEE_TOKEN）';
    }
    return `Gitee 返回 HTTP ${res.status}`;
  }

  function normItem(it, type) {
    return {
      id: it.id,
      number: it.number,
      type,
      title: String(it.title || '(无标题)'),
      state: it.state,
      user: (it.user && (it.user.login || it.user.name)) || 'unknown',
      url: it.html_url,
      updatedAt: it.updated_at,
      createdAt: it.created_at,
    };
  }

  async function fetchGithub(repo, force) {
    const url = `${API}/repos/${repo.slug}/issues?state=all&sort=updated&direction=desc&per_page=30`;
    const res = await github(url, force ? null : repo.etag);
    if (res.status === 304) return { notModified: true };
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      return {
        error:
          String(remaining) === '0'
            ? `GitHub 限流，${reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) + ' 分钟后恢复' : '稍后自动恢复'}`
            : `GitHub 拒绝请求（HTTP ${res.status}）`,
        skipUntil: reset || 0,
      };
    }
    if (!res.ok) return { error: `GitHub 返回 HTTP ${res.status}` };
    const list = await res.json();
    if (!Array.isArray(list)) return { error: 'GitHub 返回了意外的数据' };
    return {
      list: list.filter((it) => it && it.number).map((it) => normItem(it, it.pull_request ? 'pr' : 'issue')),
      etag: res.headers.get('etag') || undefined,
    };
  }

  async function fetchGitee(repo, force) {
    const etag = force ? null : repo.etag;
    const res = await gitee(`/repos/${repo.slug}/issues`, {
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: '30',
    }, etag);
    if (res.status === 304) return { notModified: true };
    if (!res.ok) return { error: giteeError(res) };
    const list = await res.json();
    if (!Array.isArray(list)) return { error: 'Gitee 返回了意外的数据' };
    const seen = new Map();
    for (const it of list) {
      if (it && it.number) seen.set(String(it.id), normItem(it, it.pull_request ? 'pr' : 'issue'));
    }
    // PR 是 Gitee 的另一个端点；读不到（限流/没权限）不影响 issue。
    try {
      const prs = await gitee(`/repos/${repo.slug}/pulls`, {
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: '20',
      });
      if (prs.ok) {
        const arr = await prs.json();
        if (Array.isArray(arr)) {
          for (const p of arr) if (p && p.number && !seen.has(String(p.id))) seen.set(String(p.id), normItem(p, 'pr'));
        }
      }
    } catch {
      /* PR 拉不到就只显示 issue */
    }
    return { list: [...seen.values()], etag: res.headers.get('etag') || undefined };
  }

  function mergeItems(repo, list, etag) {
    const firstPoll = !repo.lastPolledAt && !(repo.items && repo.items.length);
    const old = new Map((repo.items || []).map((i) => [String(i.id), i]));
    const items = [];
    for (const it of list) {
      const prev = old.get(String(it.id));
      const changed = !prev || prev.updatedAt !== it.updatedAt || prev.state !== it.state;
      items.push({
        ...it,
        read: firstPoll ? true : prev ? (changed ? false : prev.read) : false,
      });
    }
    repo.items = items.slice(0, MAX_ITEMS);
    repo.etag = etag;
  }

  async function pollOne(key, { force = false } = {}) {
    const repo = state.repos[key];
    if (!repo) return;
    if (!force && repo.skipUntil && repo.skipUntil > Date.now()) return;
    try {
      const out = repo.provider === 'gitee' ? await fetchGitee(repo, force) : await fetchGithub(repo, force);
      if (out.notModified) {
        repo.lastPolledAt = Date.now();
        repo.error = null;
        return;
      }
      if (out.error) {
        repo.error = out.error;
        if (out.skipUntil) repo.skipUntil = out.skipUntil;
        return;
      }
      mergeItems(repo, out.list, out.etag);
      repo.lastPolledAt = Date.now();
      repo.error = null;
    } catch (err) {
      repo.error = `请求失败：${err && err.message ? err.message : String(err)}`;
    }
  }

  async function pollAll(opts) {
    if (polling) return;
    polling = true;
    try {
      for (const slug of Object.keys(state.repos)) await pollOne(slug, opts);
    } finally {
      polling = false;
      persist();
    }
  }

  function arm() {
    if (timer) clearInterval(timer);
    const ms = state.settings.intervalMinutes * 60_000;
    timer = setInterval(() => {
      pollAll({}).catch(() => {});
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function addRepo(input) {
    const ref = parseRef(input);
    if (!ref.ok) {
      return { ok: false, error: '仓库要写成 owner/repo，也可以直接贴 github.com/ 或 gitee.com/ 的链接' };
    }
    if (state.repos[ref.key]) return { ok: false, error: `${ref.slug} 已经在盯着了` };
    state.repos[ref.key] = {
      key: ref.key,
      slug: ref.slug,
      provider: ref.provider,
      items: [],
      addedAt: Date.now(),
      lastPolledAt: null,
      error: null,
    };
    persist();
    return { ok: true, key: ref.key, slug: ref.slug };
  }

  function removeRepo(input) {
    const key = normalizeSlug(input);
    const repo = state.repos[key];
    if (!repo) return { ok: false, error: `没在盯 ${String(input == null ? '' : input).trim()}` };
    delete state.repos[key];
    persist();
    return { ok: true, key, slug: repo.slug };
  }

  function markRead({ slug, ids } = {}) {
    let n = 0;
    for (const repo of Object.values(state.repos)) {
      if (slug && (repo.key || repo.slug) !== normalizeSlug(slug)) continue;
      const set = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
      for (const item of repo.items || []) {
        if (item.read) continue;
        if (!set || set.has(String(item.id))) {
          item.read = true;
          n += 1;
        }
      }
    }
    persist();
    return n;
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'GET' && route === '/api/state') return sendJSON(res, 200, publicState());

      if (method === 'POST' && route === '/api/repos') {
        const body = await readBody(req);
        const r = addRepo(body.slug);
        if (!r.ok) return sendJSON(res, 400, { error: r.error });
        await pollAll({});
        await pollOne(r.key, { force: true });
        persist();
        return sendJSON(res, 200, publicState());
      }

      if (method === 'POST' && route === '/api/remove') {
        const body = await readBody(req);
        const r = removeRepo(body.slug);
        if (!r.ok) return sendJSON(res, 400, { error: r.error });
        return sendJSON(res, 200, publicState());
      }

      if (method === 'POST' && route === '/api/read') {
        const body = await readBody(req);
        markRead({ slug: body.slug, ids: body.ids });
        return sendJSON(res, 200, publicState());
      }

      if (method === 'POST' && route === '/api/check') {
        const body = await readBody(req);
        if (body.slug) await pollOne(normalizeSlug(body.slug), { force: true });
        else await pollAll({ force: true });
        persist();
        return sendJSON(res, 200, publicState());
      }

      if (method === 'POST' && route === '/api/settings') {
        const body = await readBody(req);
        if (body.intervalMinutes != null) {
          state.settings.intervalMinutes = clampInterval(body.intervalMinutes);
          persist();
          arm();
        }
        return sendJSON(res, 200, publicState());
      }

      return sendJSON(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJSON(res, 400, { error: err && err.message ? err.message : String(err) });
    }
  }

  ctx.effect(() => {
    arm();
    const kick = setTimeout(() => {
      pollAll({}).catch(() => {});
    }, 1500);
    if (typeof kick.unref === 'function') kick.unref();
    return () => {
      if (timer) clearInterval(timer);
      timer = null;
      clearTimeout(kick);
    };
  }, 'dsh-repo-watcher: poller');

  ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle });

  ctx.commands.register({
    name: 'watch',
    description: '盯住 GitHub / Gitee 仓库：有 issue / PR 变化就记下来（/watch list、/watch add owner/repo、/watch check）',
    input: { hint: 'list | add owner/repo | add gitee:owner/repo | rm owner/repo | check' },
    handler: async (input) => {
      const raw = String(input || '').trim();
      const [verb, ...rest] = raw.split(/\s+/);
      const arg = rest.join(' ');
      if (!verb || verb === 'list') {
        const s = publicState();
        if (!s.repos.length) {
          return { kind: 'success', text: '还没有盯任何仓库。用 `/watch add owner/repo` 加一个。' };
        }
        const lines = [`盯住 ${s.repos.length} 个仓库，共 ${s.unread} 条未读：`];
        for (const r of s.repos) {
          lines.push('');
          lines.push(`${r.slug} · ${r.unread ? `${r.unread} 条新变化` : '没有新变化'} · 上次检查 ${r.lastPolledText}`);
          if (r.error) lines.push(`  注意：${r.error}`);
          for (const it of r.items.slice(0, 5)) {
            lines.push(`  ${it.read ? ' ' : '•'} ${it.type === 'pr' ? 'PR' : 'Issue'} #${it.number} ${it.title} — @${it.user}`);
          }
        }
        return { kind: 'success', text: lines.join('\n') };
      }
      if (verb === 'add') {
        const r = addRepo(arg);
        if (!r.ok) return { kind: 'error', text: r.error };
        await pollOne(r.key, { force: true });
        persist();
        const repo = state.repos[r.key];
        return {
          kind: 'success',
          text: `开始盯 ${r.slug}${repo && repo.error ? `（${repo.error}）` : ''}。有变化会在设置页显示，也可以再发 /watch list 看。`,
        };
      }
      if (verb === 'rm' || verb === 'remove') {
        const r = removeRepo(arg);
        return r.ok ? { kind: 'success', text: `不再盯 ${r.slug}` } : { kind: 'error', text: r.error };
      }
      if (verb === 'check') {
        await pollAll({ force: true });
        persist();
        return { kind: 'success', text: '都检查过了。发 /watch list 看结果。' };
      }
      return { kind: 'error', text: '用法：/watch list、/watch add owner/repo、/watch add gitee:owner/repo、/watch rm owner/repo、/watch check' };
    },
  });
}

export { parseRef };
