/* ============================================================
   GlassBlog 数据抽象层：GB.store

   目的（v3 6.2 静态模式降级）：页面代码只依赖 GB.store，不关心运行模式。
   双驱动：
   - remote：探测到后端时走 /api/*（服务端 content.json，多端同步）
   - local ：纯静态托管时走 GB.load()/GB.save()（localStorage，仅本机）

   运行模式由 GB.isApi() 判定（common.js 首次 GB.load() 时探测并缓存）；
   本文件不参与探测，仅按当前模式分派，故可在 common.js 之后同步加载。

   用法：
     GB.store.memos.list({ archived }) / .tags() / .get(id, shareToken)
        / .create(fields) / .update(id, fields, rev) / .del(id) / .share(id, hours)
     GB.store.isApi   —— 当前是否后端模式
   ============================================================ */
(function () {
  /* apiJSON：在 GB.auth.request（自动带令牌、401 弹登录框）之上解析 JSON 并统一抛错 */
  async function apiJSON(url, options) {
    const res = await GB.auth.request(url, Object.assign(
      { headers: { "Content-Type": "application/json" } }, options || {}));
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { /* 空响应体 */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("请求失败 " + res.status));
      err.code = res.status;
      if (data && data.rev != null) err.rev = data.rev;
      throw err;
    }
    return data;
  }

  const memos = {
    get isApi() { return GB.isApi(); },

    // 读取当前用户可见的全部备忘；opt.archived 决定是否含归档
    async list(opt) {
      opt = opt || {};
      if (this.isApi) {
        const d = await apiJSON("api/memos" + (opt.archived ? "?includeArchived=true" : ""));
        return d.memos || [];
      }
      const c = await GB.load();
      let list = (c.memos || []).map((m) => GBSchema.normalizeMemo(m));
      if (!GB.auth.check()) list = list.filter((m) => m.visibility === "public");
      if (!opt.archived) list = list.filter((m) => !m.archived);
      return list;
    },

    async tags() {
      if (this.isApi) {
        const d = await apiJSON("api/memos/tags");
        return d.tags || [];
      }
      const list = await this.list({ archived: true });
      const map = {};
      list.forEach((m) => (m.tags || []).forEach((t) => { map[t] = (map[t] || 0) + 1; }));
      return Object.keys(map).sort().map((name) => ({ name, count: map[name] }));
    },

    async get(id, shareToken) {
      if (this.isApi) {
        const qs = shareToken ? "?share=" + encodeURIComponent(shareToken) : "";
        return await apiJSON("api/memos/" + encodeURIComponent(id) + qs);
      }
      const c = await GB.load();
      let m = (c.memos || []).find((x) => x.id === id);
      if (!m) throw new Error("备忘不存在");
      m = GBSchema.normalizeMemo(m);
      const ok = m.visibility === "public" || GB.auth.check() ||
        (shareToken && m.share && m.share.enabled && m.share.token === shareToken &&
         (!m.share.expireAt || new Date(m.share.expireAt) > new Date()));
      if (!ok) throw new Error("无权查看该备忘");
      return m;
    },

    async create(fields) {
      if (this.isApi) {
        const memo = await apiJSON("api/memos", { method: "POST", body: JSON.stringify(fields) });
        GB.emit("memo:created", { memo });
        return memo;
      }
      const c = await GB.load();
      const now = GBSchema.nowISO();
      const memo = GBSchema.normalizeMemo(Object.assign({
        id: GBSchema.genId("memo"), createdAt: now, updatedAt: now, rev: 1,
      }, fields));
      c.memos = c.memos || [];
      c.memos.unshift(memo);
      await GB.save(c);
      GB.emit("memo:created", { memo });
      return memo;
    },

    async update(id, fields, rev) {
      if (this.isApi) {
        const memo = await apiJSON("api/memos/" + encodeURIComponent(id), {
          method: "PUT", body: JSON.stringify(Object.assign({}, fields, { rev })),
        });
        GB.emit("memo:updated", { memo });
        return memo;
      }
      const c = await GB.load();
      const i = (c.memos || []).findIndex((x) => x.id === id);
      if (i < 0) throw new Error("备忘不存在");
      const cur = c.memos[i];
      if (rev != null && cur.rev !== rev) {
        const err = new Error("内容已被其他地方修改");
        err.code = 409; err.rev = cur.rev; err.serverMemo = cur;
        throw err;
      }
      const next = GBSchema.normalizeMemo(Object.assign({}, cur, fields, {
        id: cur.id, createdAt: cur.createdAt,
        updatedAt: GBSchema.nowISO(), rev: (cur.rev || 1) + 1,
      }));
      c.memos[i] = next;
      await GB.save(c);
      GB.emit("memo:updated", { memo: next });
      return next;
    },

    async del(id) {
      if (this.isApi) {
        await apiJSON("api/memos/" + encodeURIComponent(id), { method: "DELETE" });
      } else {
        const c = await GB.load();
        c.memos = (c.memos || []).filter((x) => x.id !== id);
        await GB.save(c);
      }
      GB.emit("memo:deleted", { id });
    },

    // 生成分享链接：静态模式无服务端令牌校验，返回 null（页面据此隐藏入口）
    async share(id, expireHours) {
      if (!this.isApi) return null;
      return await apiJSON("api/memos/" + encodeURIComponent(id) + "/share", {
        method: "POST", body: JSON.stringify({ expireHours }),
      });
    },
  };

  GB.store = { memos, get isApi() { return GB.isApi(); } };
})();
