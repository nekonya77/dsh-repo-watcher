// dsh-repo-watcher — browser half.
//
// 由 dsh-client-modules 从 /plugins/dsh-repo-watcher/client.js 加载，
// 通过 vendored cordis Loader 的 lazy-CJS 模块表执行（与官方 ui-* 产物同形）。
// 只注册一个「设置 → 仓库雷达」页；react 由 shell 提供。

(function (root) {
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    id: "dsh-repo-watcher",
    factory: (require) => {
      const module = { exports: {} };
      const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      let React = null;
      try {
        React = require("react");
      } catch (e) {
        React = null;
      }

      const inject = ["slots", "locale"];
      const h = React ? React.createElement : null;

      const API = "/repo-watcher/api";

      const S = {
        page: { padding: "20px 4px 40px", maxWidth: 860, margin: "0 auto", fontSize: 14, lineHeight: 1.6 },
        h1: { fontSize: 18, fontWeight: 650, margin: "0 0 4px" },
        intro: { opacity: 0.62, margin: "0 0 18px", fontSize: 13 },
        card: {
          border: "1px solid rgba(128,128,128,0.22)",
          borderRadius: 10,
          padding: "12px 14px",
          marginBottom: 10,
          background: "rgba(128,128,128,0.04)",
        },
        row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
        input: {
          flex: 1,
          minWidth: 220,
          padding: "7px 9px",
          borderRadius: 7,
          border: "1px solid rgba(128,128,128,0.35)",
          background: "transparent",
          color: "inherit",
          fontSize: 13,
          outline: "none",
        },
        btn: {
          padding: "6px 12px",
          borderRadius: 7,
          border: "1px solid rgba(128,128,128,0.35)",
          background: "rgba(128,128,128,0.10)",
          color: "inherit",
          cursor: "pointer",
          fontSize: 13,
        },
        btnPrimary: {
          padding: "6px 14px",
          borderRadius: 7,
          border: "1px solid rgba(80,140,255,0.55)",
          background: "rgba(80,140,255,0.16)",
          color: "inherit",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
        },
        pill: {
          display: "inline-block",
          minWidth: 18,
          padding: "0 6px",
          borderRadius: 99,
          background: "rgba(235,90,90,0.18)",
          color: "#e05c5c",
          fontSize: 12,
          lineHeight: "18px",
          textAlign: "center",
          fontWeight: 600,
        },
        meta: { opacity: 0.55, fontSize: 12 },
        item: { padding: "7px 0", borderTop: "1px solid rgba(128,128,128,0.14)" },
        tag: {
          display: "inline-block",
          padding: "0 6px",
          borderRadius: 4,
          fontSize: 11,
          marginRight: 6,
          background: "rgba(128,128,128,0.16)",
        },
        err: { color: "#d9534f", fontSize: 13, marginTop: 6 },
        empty: { padding: "26px 0", textAlign: "center", opacity: 0.55 },
      };

      async function call(pathname, body) {
        const init = body
          ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {};
        const res = await fetch(API + pathname, init);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "请求失败（HTTP " + res.status + "）");
        return data;
      }

      function RepoWatcherPage() {
        const [state, setState] = React.useState(null);
        const [err, setErr] = React.useState(null);
        const [slug, setSlug] = React.useState("");
        const [busy, setBusy] = React.useState("");

        const refresh = React.useCallback(() => {
          call("/state")
            .then((s) => {
              setState(s);
              setErr(null);
            })
            .catch((e) => setErr(e.message || String(e)));
        }, []);

        React.useEffect(() => {
          refresh();
          const t = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
          }, 20000);
          return () => clearInterval(t);
        }, [refresh]);

        const guard = (key, fn) => {
          setBusy(key);
          setErr(null);
          Promise.resolve()
            .then(fn)
            .then((s) => {
              if (s) setState(s);
            })
            .catch((e) => setErr(e.message || String(e)))
            .finally(() => setBusy(""));
        };

        const add = () =>
          guard("add", async () => {
            const s = await call("/repos", { slug });
            setSlug("");
            return s;
          });

        if (!state) {
          return h(
            "div",
            { style: S.page },
            h("h1", { style: S.h1 }, "仓库雷达"),
            err ? h("div", { style: S.err }, err) : h("div", { style: S.meta }, "正在读取…")
          );
        }

        const repos = state.repos || [];

        return h(
          "div",
          { style: S.page },
          h("h1", { style: S.h1 }, "仓库雷达"),
          h(
            "p",
            { style: S.intro },
            "盯住你关心的 GitHub / Gitee 仓库。有人提 issue、发 PR、或状态变了，这里会记下来——不用再切回网页反复刷新。"
          ),

          h(
            "div",
            { style: S.row, marginBottom: 18 },
            h("input", {
              style: S.input,
              value: slug,
              placeholder: "owner/repo，或 gitee:owner/repo、github.com/… 链接",
              onChange: (e) => setSlug(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") add();
              },
            }),
            h(
              "button",
              { style: S.btnPrimary, disabled: busy === "add" || !slug.trim(), onClick: add },
              busy === "add" ? "添加中…" : "盯住它"
            ),
            h(
              "select",
              {
                style: { ...S.btn, paddingRight: 8 },
                value: state.settings.intervalMinutes,
                onChange: (e) =>
                  guard("interval", () => call("/settings", { intervalMinutes: Number(e.target.value) })),
              },
              h("option", { value: 5 }, "每 5 分钟查"),
              h("option", { value: 10 }, "每 10 分钟查"),
              h("option", { value: 30 }, "每 30 分钟查"),
              h("option", { value: 60 }, "每 1 小时查")
            )
          ),

          err ? h("div", { style: { ...S.err, marginBottom: 10 } }, err) : null,

          state.unread
            ? h(
                "div",
                { style: { ...S.row, marginBottom: 10 } },
                h("span", { style: S.meta }, state.unread + " 条没看过"),
                h(
                  "button",
                  { style: S.btn, onClick: () => guard("read", () => call("/read", {})) },
                  "全部标为已读"
                )
              )
            : null,

          repos.length === 0
            ? h(
                "div",
                { style: S.empty },
                "还没盯任何仓库。",
                h("br"),
                "加一个：AI 在后台干活时，你就知道仓库那边有没有新动静。"
              )
            : null,

          repos.map((r) =>
            h(
              "div",
              { key: r.slug, style: S.card },
              h(
                "div",
                { style: S.row },
                h("strong", null, r.slug),
                r.unread ? h("span", { style: S.pill }, String(r.unread)) : null,
                h("span", { style: S.meta }, "上次检查 " + (r.lastPolledText || "还没")),
                h("span", { style: { flex: 1 } }),
                h(
                  "button",
                  {
                    style: S.btn,
                    disabled: busy === "check:" + r.slug,
                    onClick: () => guard("check:" + r.slug, () => call("/check", { slug: r.slug })),
                  },
                  busy === "check:" + r.slug ? "检查中…" : "检查"
                ),
                h(
                  "button",
                  {
                    style: S.btn,
                    onClick: () => {
                      if (typeof window !== "undefined" && window.confirm) {
                        if (!window.confirm("不再盯 " + r.slug + "？")) return;
                      }
                      guard("rm:" + r.slug, () => call("/remove", { slug: r.slug }));
                    },
                  },
                  "移除"
                )
              ),
              r.error ? h("div", { style: S.err }, r.error) : null,
              r.items && r.items.length
                ? r.items.slice(0, 12).map((it) =>
                    h(
                      "div",
                      { key: it.id, style: S.item },
                      h("span", { style: S.tag }, it.type === "pr" ? "PR" : "ISSUE"),
                      h(
                        "a",
                        {
                          href: it.url,
                          target: "_blank",
                          rel: "noreferrer",
                          style: {
                            color: "inherit",
                            fontWeight: it.read ? 400 : 600,
                            textDecoration: "none",
                          },
                        },
                        "#" + it.number + " " + it.title
                      ),
                      h("span", { style: S.meta }, " · @" + it.user),
                      it.state === "open" ? null : h("span", { style: S.meta }, " · " + it.state)
                    )
                  )
                : h("div", { style: S.meta, marginTop: 6 }, "还没有条目。第一次检查可能要几秒。")
              )
            )
        );
      }

      function apply(ctx) {
        if (!h) return;
        ctx.effect(
          () =>
            ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                {
                  name: "settings.section",
                  id: "repo-watcher",
                  order: 46,
                  label: () => "仓库雷达",
                },
                () => React.createElement(RepoWatcherPage)
              )
            ),
          "dsh-repo-watcher: settings page"
        );
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null);
