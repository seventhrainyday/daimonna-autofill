// ==UserScript==
// @name         Daimonna 地址生成 · 一键自动填充
// @namespace    https://address.daimonna.com/
// @version      1.1.0
// @description  在任意网站一键调用 Daimonna 生成真实格式的身份/地址信息，并智能填充到当前页面表单。支持选国家/州省/城市/区县/邮编、快捷地区、IP 地区生成、批量生成、历史与收藏。
// @author       Muse
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @connect      address.daimonna.com
// @downloadURL  https://raw.githubusercontent.com/seventhrainyday/daimonna-autofill/main/daimonna-autofill.user.js
// @updateURL    https://raw.githubusercontent.com/seventhrainyday/daimonna-autofill/main/daimonna-autofill.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 配置 ================= */
  const API_BASE = 'https://address.daimonna.com/web-api';

  const COUNTRIES = [
    ['US', '美国 United States'], ['CA', '加拿大 Canada'], ['MX', '墨西哥 Mexico'],
    ['GB', '英国 United Kingdom'], ['DE', '德国 Germany'], ['FR', '法国 France'],
    ['IT', '意大利 Italy'], ['ES', '西班牙 Spain'], ['NL', '荷兰 Netherlands'], ['RU', '俄罗斯 Russia'],
    ['CN', '中国 China'], ['HK', '香港 Hong Kong'], ['TW', '台湾 Taiwan'], ['JP', '日本 Japan'],
    ['SG', '新加坡 Singapore'], ['KR', '韩国 South Korea'],
    ['VN', '越南 Vietnam'], ['TH', '泰国 Thailand'], ['PH', '菲律宾 Philippines'], ['MY', '马来西亚 Malaysia'],
    ['IN', '印度 India'], ['AU', '澳大利亚 Australia'],
    ['TR', '土耳其 Türkiye'], ['SA', '沙特 Saudi Arabia'], ['BR', '巴西 Brazil'],
    ['NG', '尼日利亚 Nigeria'], ['ZA', '南非 South Africa'],
  ];
  const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map(([c, n]) => [c, n]));
  const PLURAL = { region: 'regions', city: 'cities', district: 'districts', postcode: 'postcodes' };

  /* ================= 工具 ================= */
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function toast(msg, ok = true) {
    let t = $('#daimonna-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'daimonna-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;background:#111827;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:86vw;text-align:center;transition:opacity .3s;pointer-events:none;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = ok ? '#111827' : '#b91c1c';
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 2800);
  }

  function gmJson(url, timeout = 25000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: { Accept: 'application/json' }, timeout,
        onload(res) {
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(new Error('接口返回解析失败')); }
        },
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  // 兼容 React / Vue 受控组件的赋值方式
  function setNativeValue(el, value) {
    if (value == null) return false;
    const str = String(value);
    if (el.isContentEditable) { el.textContent = str; }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter && el.value !== str) setter.call(el, str); else el.value = str;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function setSelectValue(sel, candidates) {
    const opts = [...sel.options];
    const norm = (s) => String(s || '').trim().toLowerCase();
    for (const cand of candidates) {
      if (!cand) continue;
      const c = norm(cand);
      const hit = opts.find(o => norm(o.value) === c || norm(o.textContent) === c)
        || opts.find(o => c.length >= 3 && (norm(o.textContent).includes(c) || norm(o.value).includes(c)))
        || opts.find(o => norm(o.textContent).length >= 3 && c.startsWith(norm(o.textContent)));
      if (hit) { setNativeValue(sel, hit.value); return true; }
    }
    return false;
  }

  /* ================= Daimonna 接口 ================= */
  // 生成：GET /web-api/v1/generate?country&regionId&cityId&districtId&postcodeId&residential&seed&requestId&strategy&q / mode=ip-region&ip
  // 地点：GET /web-api/v1/locations/search?country&field=region|city|district|postcode&regionId&cityId&q&limit&cursor
  // 快捷：GET /web-api/v1/config/country-shortcuts ；IP 定位：GET /web-api/v1/client-context?ip=
  async function fetchIdentity(country, opts = {}) {
    const requestId = uuid();
    const params = new URLSearchParams({
      requestId, country,
      residential: String(opts.residential ?? (country === 'CN')),
      seed: requestId.slice(0, 12),
      strategy: 'random',
    });
    const f = opts.filters || {};
    for (const k of ['regionId', 'cityId', 'districtId', 'postcodeId']) if (f[k]) params.set(k, f[k]);
    if (opts.keyword) params.set('q', opts.keyword);
    if (opts.ipMode) { params.set('mode', 'ip-region'); if (opts.ip) params.set('ip', opts.ip); }
    const json = await gmJson(`${API_BASE}/v1/generate?${params}`);
    const r = json?.data?.result;
    if (!r) throw new Error('接口返回异常：' + JSON.stringify(json).slice(0, 160));
    return { identity: normalize(r, json.data.country || country), matchLevel: json.data.filterMatchLevel || '' };
  }

  async function fetchLocationItems(country, field, extra = {}) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 4; page++) {
      const params = new URLSearchParams({ country, field, limit: '200', ...extra });
      if (cursor) params.set('cursor', cursor);
      const json = await gmJson(`${API_BASE}/v1/locations/search?${params}`);
      const data = json?.data || {};
      const batch = (data[PLURAL[field]] || []).filter((x) => !x.disabled);
      items.push(...batch);
      cursor = data.nextCursor;
      if (!cursor || batch.length === 0) break;
    }
    return items;
  }

  async function searchLocationItems(country, field, extra = {}, q = '') {
    const params = new URLSearchParams({ country, field, limit: '30', ...extra });
    if (q) params.set('q', q);
    const json = await gmJson(`${API_BASE}/v1/locations/search?${params}`);
    return ((json?.data || {})[PLURAL[field]] || []).filter((x) => !x.disabled);
  }

  let shortcutsCache = null;
  async function fetchShortcuts() {
    if (!shortcutsCache) {
      const json = await gmJson(`${API_BASE}/v1/config/country-shortcuts`);
      shortcutsCache = json?.data || {};
    }
    return shortcutsCache;
  }

  async function fetchClientContext(ip) {
    const params = ip ? `?ip=${encodeURIComponent(ip)}` : '';
    const json = await gmJson(`${API_BASE}/v1/client-context${params}`);
    return json?.data || null;
  }

  function normalize(r, country) {
    const p = r.profile || {};
    const a = r.address || {};
    const c = a.components || {};
    const ext = r.extensions || {};
    const card = r.card || {};
    const cc = a.countryCode || country;

    let firstName = '', lastName = '';
    const full = (p.fullName || '').trim();
    if (full.includes(' ')) {
      const parts = full.split(/\s+/);
      if (['JP', 'CN', 'TW', 'HK', 'KR'].includes(cc)) { lastName = parts[0]; firstName = parts.slice(1).join(' '); }
      else { firstName = parts[0]; lastName = parts.slice(1).join(' '); }
    } else if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(full) && full.length >= 2) {
      lastName = full.slice(0, 1); firstName = full.slice(1);
    } else { firstName = full; }

    const streetLine = [c.houseNumber, c.street].filter(Boolean).join(' ').trim() || c.buildingName || '';
    const address1 = [streetLine, c.buildingName && streetLine !== c.buildingName ? c.buildingName : '', c.unit].filter(Boolean).join(', ');
    const city = c.locality || c.postalLocality || c.district || '';

    return {
      country: cc, countryName: COUNTRY_NAME[cc] || cc,
      fullName: full, firstName, lastName,
      gender: p.gender || '', email: p.email || '', phone: p.phone || '',
      phoneLocal: (p.phone || '').replace(/^\+\d+\s*/, ''),
      dob: p.dateOfBirth || '',
      address1, address2: c.district && c.district !== city ? c.district : (c.unit || ''),
      street: streetLine, city, district: c.district || '',
      state: c.admin1 || '', stateCode: c.admin1Code || '',
      postcode: c.postcode || '',
      formattedAddress: a.formattedAddress || a.nativeAddress || '',
      nativeAddress: a.nativeAddress || '',
      postalSingle: r.addressFormats?.en?.singleLine || r.addressFormats?.native?.singleLine || '',
      mapsUrl: a.googleMaps?.openUrl || '',
      company: ext.employment?.company || '', occupation: ext.employment?.occupation || '',
      username: ext.internet?.username || '',
      password: ext.internet?.testPassword || '',
      cardNetwork: card.network || '', cardNumber: card.number || '',
      cardExpiry: card.expiry || '', cardCvc: card.cvc || '',
    };
  }

  /* ================= 表单字段识别 ================= */
  const FIELD_RULES = [
    ['cardNumber', /cc[-_ ]?number|card[-_ ]?number|credit[-_ ]?card|卡号|信用卡/i, /^(cc-number)$/],
    ['cardExpiry', /cc[-_ ]?exp|card[-_ ]?expir|expiry|exp[-_ ]?date|有效期|到期/i, /^(cc-exp)$/],
    ['cardCvc', /cc[-_ ]?csc|cvc|cvv|security[-_ ]?code|安全码/i, /^(cc-csc)$/],
    ['email', /e[-_ ]?mail|邮箱|电子邮件/i, /^(email)$/],
    ['phone', /phone|mobile|tel\b|telephone|手机|电话|連絡/i, /^(tel|tel-national)$/],
    ['postcode', /postal|zip|post[-_ ]?code|邮编|郵便番号/i, /^(postal-code)$/],
    ['dob', /birth|dob|birthday|出生|生日/i, /^(bday)$/],
    ['username', /user[-_ ]?name|用户名|账号|帳號/i, /^(username)$/],
    ['password', /password|密码|密碼/i, /^(new-password|current-password)$/],
    ['firstName', /first[-_ ]?name|given[-_ ]?name|名(?!称)|名字/i, /^(given-name)$/],
    ['lastName', /last[-_ ]?name|family[-_ ]?name|surname|姓/i, /^(family-name)$/],
    ['fullName', /full[-_ ]?name|real[-_ ]?name|contact[-_ ]?name|姓名|收件人|收货人|联系人/i, /^(name|cc-name)$/],
    ['company', /company|organization|公司|單位|单位/i, /^(organization)$/],
    ['country', /country|国家|國家|地区|地區/i, /^(country|country-name)$/],
    ['state', /state|province|region|省|州|都道府县|縣|县/i, /^(address-level1)$/],
    ['city', /city|城市|市\b|市区町村/i, /^(address-level2)$/],
    ['address2', /address[-_ ]?(line)?[-_ ]?2|addr2|apartment|suite|unit|详细地址2|门牌|楼栋/i, /^(address-line2)$/],
    ['address1', /address|street|addr|街道|地址/i, /^(street-address|address-line1)$/],
  ];

  // WHMCS 注册/结账表单字段名写死（v6vps 等大量 VPS 商家都用 WHMCS），按 name 精确匹配最稳
  const WHMCS_NAME_MAP = {
    firstname: 'firstName', lastname: 'lastName', email: 'email',
    phonenumber: 'phone', companyname: 'company',
    address1: 'address1', address2: 'address2', city: 'city',
    state: 'state', postcode: 'postcode', country: 'country',
    password: 'password', password2: 'password',
  };

  function labelTextOf(el) {
    const parts = [];
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) parts.push(lab.textContent);
    }
    const wrapLab = el.closest('label');
    if (wrapLab) parts.push(wrapLab.textContent);
    const parent = el.closest('div,td,li,section');
    if (parent) {
      const l = parent.querySelector(':scope > label, :scope > span, :scope > div');
      if (l && l !== el) parts.push(l.textContent);
    }
    return parts.join(' ').trim();
  }

  function classifyField(el) {
    const exact = WHMCS_NAME_MAP[(el.name || '').toLowerCase()];
    if (exact) return exact;
    const ac = (el.getAttribute('autocomplete') || '').trim();
    const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelTextOf(el)].filter(Boolean).join(' ');
    for (const [key, , acRe] of FIELD_RULES) { if (ac && acRe.test(ac)) return key; }
    for (const [key, re] of FIELD_RULES) { if (re.test(hay)) return key; }
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
    if (el.type === 'date' && /birth|dob/i.test(hay)) return 'dob';
    return null;
  }

  function fillForm(idata, opts) {
    const values = {
      fullName: idata.fullName, firstName: idata.firstName, lastName: idata.lastName,
      email: idata.email, phone: idata.phone, postcode: idata.postcode, dob: idata.dob,
      username: idata.username, password: idata.password, company: idata.company,
      state: idata.state, city: idata.city,
      address1: idata.address1 || idata.formattedAddress, address2: idata.address2,
      country: idata.country,
      cardNumber: opts.withCard ? idata.cardNumber : '',
      cardExpiry: opts.withCard ? idata.cardExpiry : '',
      cardCvc: opts.withCard ? idata.cardCvc : '',
    };
    // 站点密码最低长度要求（data-min-length）：统一补足一次，保证密码与确认密码一致
    const pwdMin = Math.max(0, ...[...document.querySelectorAll('input[type="password"]')]
      .map((e) => parseInt(e.getAttribute('data-min-length') || '0', 10) || 0));
    if (values.password && pwdMin && values.password.length < pwdMin) {
      const pad = 'Aa1!xY9#Qq2@';
      let v = values.password;
      while (v.length < pwdMin) v += pad[v.length % pad.length];
      values.password = v;
    }
    const SKIP_TYPES = ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'];
    const els = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
      if (el.closest('#daimonna-panel')) return false;
      if (SKIP_TYPES.includes(el.type)) return false;
      if (el.disabled || el.readOnly) return false;
      if (el.offsetParent === null) return false;
      return true;
    });

    let filled = 0; const detail = [];
    const usedFullNameFallback = new Set();
    for (const el of els) {
      const key = classifyField(el);
      if (!key) continue;
      let val = values[key];
      if (key === 'country') {
        if (el.tagName === 'SELECT') { if (setSelectValue(el, [idata.country, idata.countryName, idata.countryName.split(' ').pop()])) { filled++; detail.push('国家'); } }
        else if (setNativeValue(el, idata.country)) { filled++; detail.push('国家'); }
        continue;
      }
      if (key === 'state' && el.tagName === 'SELECT') {
        if (setSelectValue(el, [idata.stateCode, idata.state])) { filled++; detail.push('州/省'); }
        continue;
      }
      if (key === 'phone' && el.type === 'tel') val = idata.phone;
      if (!val) {
        if ((key === 'firstName' || key === 'lastName') && idata.fullName && !usedFullNameFallback.has(el.form)) {
          val = idata.fullName; usedFullNameFallback.add(el.form);
        } else continue;
      }
      if (el.tagName === 'SELECT') { if (setSelectValue(el, [val])) { filled++; detail.push(key); } }
      else if (setNativeValue(el, val)) {
        filled++;
        el.style.outline = '2px solid #22c55e';
        setTimeout(() => { el.style.outline = ''; }, 1800);
        detail.push(key);
      }
    }
    return { filled, detail };
  }

  /* ================= UI 面板 ================= */
  const style = document.createElement('style');
  style.textContent = `
    #daimonna-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#2563eb;color:#fff;border:none;border-radius:999px;padding:11px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(37,99,235,.45);}
    #daimonna-fab:hover{background:#1d4ed8}
    #daimonna-panel{position:fixed;right:18px;bottom:66px;z-index:2147483646;width:356px;max-width:calc(100vw - 24px);background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.22);font-size:13px;overflow:hidden;display:none;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}
    #daimonna-panel.open{display:block}
    #daimonna-panel header{display:flex;justify-content:space-between;align-items:center;background:#eff6ff;padding:10px 12px;font-weight:700;}
    #daimonna-panel header button{background:none;border:none;cursor:pointer;font-size:16px;color:#6b7280;}
    #daimonna-panel .body{padding:12px;display:flex;flex-direction:column;gap:8px;max-height:68vh;overflow:auto;}
    #daimonna-panel .row{display:flex;gap:8px;align-items:center;}
    #daimonna-panel select,#daimonna-panel input[type="text"]{width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-size:13px;box-sizing:border-box;}
    #daimonna-panel select:disabled,#daimonna-panel input:disabled{background:#f3f4f6;color:#9ca3af;}
    #daimonna-panel .btn{flex:1;padding:9px 6px;border-radius:9px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-weight:600;font-size:13px;}
    #daimonna-panel .btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}
    #daimonna-panel .btn:disabled{opacity:.55;cursor:wait;}
    #daimonna-panel .btn.small{flex:0 0 auto;padding:5px 10px;font-size:12px;}
    #daimonna-panel label.chk{display:flex;gap:6px;align-items:center;color:#374151;cursor:pointer;}
    #daimonna-panel .flabel{color:#6b7280;font-size:12px;margin-bottom:-4px;}
    #daimonna-panel .combo{position:relative;}
    #daimonna-panel .combo-list{position:absolute;left:0;right:0;top:calc(100% + 4px);background:#fff;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);max-height:190px;overflow:auto;z-index:30;display:none;}
    #daimonna-panel .combo-list.open{display:block}
    #daimonna-panel .combo-item{padding:7px 10px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;}
    #daimonna-panel .combo-item:hover{background:#eff6ff}
    #daimonna-panel .combo-item .cnt{color:#9ca3af;font-size:11px;white-space:nowrap;}
    #daimonna-panel .combo-item.none{color:#9ca3af;cursor:default;}
    #daimonna-panel .chips{display:flex;flex-wrap:wrap;gap:5px;}
    #daimonna-panel .chip{border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;border-radius:999px;padding:3px 9px;font-size:12px;cursor:pointer;}
    #daimonna-panel .chip:hover{background:#dbeafe}
    #daimonna-panel .sect{border-top:1px dashed #e5e7eb;padding-top:8px;}
    #daimonna-panel .sect-title{font-weight:700;font-size:12px;color:#374151;margin-bottom:5px;}
    #daimonna-preview .item{display:flex;gap:6px;padding:3px 0;cursor:pointer;border-radius:6px;}
    #daimonna-preview .item:hover{background:#f3f4f6;}
    #daimonna-preview .k{color:#6b7280;flex:0 0 64px;}
    #daimonna-preview .v{word-break:break-all;font-weight:500;}
    #daimonna-panel .hist-item{display:flex;gap:6px;align-items:center;padding:4px 0;}
    #daimonna-panel .hist-item .info{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;}
    #daimonna-panel .hist-item .info:hover{color:#2563eb}
    #daimonna-panel .hint{color:#9ca3af;font-size:12px;line-height:1.5;}
    #daimonna-panel a{color:#2563eb;}
  `;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'daimonna-fab';
  fab.textContent = '🪪 地址填充';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'daimonna-panel';
  panel.innerHTML = `
    <header><span>Daimonna 身份生成</span><button id="dm-close" title="关闭">✕</button></header>
    <div class="body">
      <span class="flabel">国家 / 地区</span>
      <select id="dm-country">${COUNTRIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select>
      <span class="flabel">州 / 省（可选）</span>
      <select id="dm-region"><option value="">全部州/省</option></select>
      <span class="flabel">城市（可选，可输入搜索）</span>
      <div class="combo"><input type="text" id="dm-city" placeholder="全部城市" autocomplete="off"><div class="combo-list" id="dm-city-list"></div></div>
      <span class="flabel">区县（可选，可输入搜索）</span>
      <div class="combo"><input type="text" id="dm-district" placeholder="先选城市" autocomplete="off" disabled><div class="combo-list" id="dm-district-list"></div></div>
      <span class="flabel">邮编（可选，可输入搜索）</span>
      <div class="combo"><input type="text" id="dm-postcode" placeholder="先选城市" autocomplete="off" disabled><div class="combo-list" id="dm-postcode-list"></div></div>
      <div id="dm-shortcuts"></div>
      <span class="flabel">地址关键词（可选，必须出现在地址里，如 Seattle）</span>
      <input type="text" id="dm-keyword" placeholder="留空不限" autocomplete="off">
      <div class="row">
        <label class="chk"><input type="checkbox" id="dm-residential"> 住宅地址</label>
        <label class="chk"><input type="checkbox" id="dm-with-card"> 填充测试银行卡</label>
      </div>
      <div class="row">
        <button class="btn primary" id="dm-gen-fill">⚡ 生成并填充</button>
        <button class="btn" id="dm-gen-only">仅生成预览</button>
      </div>
      <div class="row">
        <button class="btn" id="dm-batch">批量生成 ×5</button>
        <button class="btn" id="dm-fill-last">填充当前这套</button>
        <button class="btn" id="dm-copy-all">复制全部</button>
      </div>
      <div class="sect">
        <div class="sect-title">📍 按 IP 地区生成</div>
        <div class="row">
          <input type="text" id="dm-ip" placeholder="IP 地址（留空 = 你当前 IP）" autocomplete="off">
          <button class="btn small" id="dm-ip-ctx">检测</button>
          <button class="btn small" id="dm-ip-gen">生成并填充</button>
        </div>
        <div class="hint" id="dm-ip-info"></div>
      </div>
      <div id="daimonna-preview" class="sect" style="display:none"></div>
      <div class="sect" id="dm-history-sect" style="display:none"><div class="sect-title">🕘 历史生成（点条目预览，点填充直接用）</div><div id="dm-history"></div></div>
      <div class="sect" id="dm-fav-sect" style="display:none"><div class="sect-title">⭐ 收藏（点条目预览，点填充直接用）</div><div id="dm-favorites"></div></div>
      <div class="row"><button class="btn" id="dm-fav-add">⭐ 收藏当前这套</button><button class="btn" id="dm-clear-hist">清空历史</button></div>
      <div class="hint">快捷键 Alt+Shift+F 快速生成并填充。预览里点任意行可复制。数据来自 address.daimonna.com，银行卡为测试数据、请勿用于真实支付。</div>
    </div>`;
  document.body.appendChild(panel);

  /* ================= 状态 ================= */
  const countrySel = panel.querySelector('#dm-country');
  const regionSel = panel.querySelector('#dm-region');
  const keywordInput = panel.querySelector('#dm-keyword');
  const residentialChk = panel.querySelector('#dm-residential');
  const withCardChk = panel.querySelector('#dm-with-card');
  let current = GM_getValue('dm_last', null);
  let history = GM_getValue('dm_history', []);
  let favorites = GM_getValue('dm_favorites', []);

  countrySel.value = GM_getValue('dm_country', 'US');
  withCardChk.checked = GM_getValue('dm_with_card', false);
  residentialChk.checked = GM_getValue('dm_residential', countrySel.value === 'CN');
  withCardChk.addEventListener('change', () => GM_setValue('dm_with_card', withCardChk.checked));
  residentialChk.addEventListener('change', () => GM_setValue('dm_residential', residentialChk.checked));

  function currentFilters() {
    return {
      regionId: regionSel.value || null,
      cityId: cityCombo.selected?.id || null,
      districtId: districtCombo.selected?.id || null,
      postcodeId: postcodeCombo.selected?.id || null,
    };
  }
  function saveFilters() {
    GM_setValue('dm_filters', {
      country: countrySel.value,
      regionId: regionSel.value || null,
      city: cityCombo.selected, district: districtCombo.selected, postcode: postcodeCombo.selected,
    });
  }

  /* ================= 级联地点选择 ================= */
  async function loadRegions(restoreId) {
    regionSel.innerHTML = '<option value="">加载中…</option>';
    regionSel.disabled = true;
    try {
      const items = await fetchLocationItems(countrySel.value, 'region');
      regionSel.innerHTML = '<option value="">全部州/省</option>' + items.map((it) =>
        `<option value="${esc(it.id)}">${esc(it.label || it.value)}</option>`).join('');
      regionSel.disabled = false;
      if (restoreId && items.some((x) => String(x.id) === String(restoreId))) regionSel.value = String(restoreId);
    } catch (e) {
      regionSel.innerHTML = '<option value="">加载失败，点国家重选可重试</option>';
      regionSel.disabled = false;
    }
    onRegionChange(false);
  }

  function makeCombo(input, listEl, field, getExtra, onChange) {
    const combo = {
      selected: null,
      _timer: null,
      async load(q = '') {
        listEl.innerHTML = '<div class="combo-item none">加载中…</div>';
        listEl.classList.add('open');
        try {
          const items = await searchLocationItems(countrySel.value, field, getExtra(), q);
          if (!items.length) { listEl.innerHTML = '<div class="combo-item none">无匹配（可留空不限）</div>'; return; }
          listEl.innerHTML = items.map((it, i) => `<div class="combo-item" data-i="${i}"><span>${esc(it.label || it.value)}</span><span class="cnt">${it.availableCount ?? ''}</span></div>`).join('');
          listEl.querySelectorAll('.combo-item[data-i]').forEach((node) => node.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            combo.setSelected(items[Number(node.dataset.i)]);
            listEl.classList.remove('open');
          }));
        } catch (e) { listEl.innerHTML = '<div class="combo-item none">加载失败，稍后重试</div>'; }
      },
      setSelected(item) {
        combo.selected = item ? { id: String(item.id), value: item.value, label: item.label || item.value, regionId: item.regionId || null } : null;
        input.value = item ? (item.label || item.value) : '';
        onChange && onChange(combo.selected);
      },
      reset(placeholder, disabled) {
        combo.selected = null; input.value = ''; input.placeholder = placeholder; input.disabled = !!disabled;
        listEl.classList.remove('open');
      },
    };
    input.addEventListener('focus', () => { if (!input.disabled) combo.load(input.value.trim() === (combo.selected?.label || '') ? '' : input.value.trim()); });
    input.addEventListener('input', () => {
      if (combo.selected && input.value !== combo.selected.label) { combo.selected = null; onChange && onChange(null); }
      clearTimeout(combo._timer);
      combo._timer = setTimeout(() => combo.load(input.value.trim()), 300);
    });
    input.addEventListener('blur', () => setTimeout(() => listEl.classList.remove('open'), 150));
    return combo;
  }

  const cityCombo = makeCombo(panel.querySelector('#dm-city'), panel.querySelector('#dm-city-list'), 'city',
    () => (regionSel.value ? { regionId: regionSel.value } : {}),
    (sel) => {
      // 未选州时从城市自带 regionId 反填州
      if (sel && !regionSel.value && sel.regionId && [...regionSel.options].some((o) => o.value === String(sel.regionId))) {
        regionSel.value = String(sel.regionId);
      }
      districtCombo.reset('全部区县', !sel);
      postcodeCombo.reset('全部邮编', !sel);
      saveFilters();
    });
  const districtCombo = makeCombo(panel.querySelector('#dm-district'), panel.querySelector('#dm-district-list'), 'district',
    () => ({ ...(regionSel.value ? { regionId: regionSel.value } : {}), ...(cityCombo.selected ? { cityId: cityCombo.selected.id } : {}) }),
    () => saveFilters());
  const postcodeCombo = makeCombo(panel.querySelector('#dm-postcode'), panel.querySelector('#dm-postcode-list'), 'postcode',
    () => ({ ...(regionSel.value ? { regionId: regionSel.value } : {}), ...(cityCombo.selected ? { cityId: cityCombo.selected.id } : {}) }),
    () => saveFilters());

  function onRegionChange(cascade = true) {
    if (cascade) { cityCombo.reset('全部城市', false); districtCombo.reset('先选城市', true); postcodeCombo.reset('先选城市', true); }
    saveFilters();
  }
  regionSel.addEventListener('change', () => onRegionChange(true));

  /* ================= 快捷地区（与官网同源） ================= */
  async function renderShortcuts() {
    const box = panel.querySelector('#dm-shortcuts');
    box.innerHTML = '';
    try {
      const all = await fetchShortcuts();
      const cfg = all[countrySel.value];
      if (!cfg) return;
      const groups = [];
      if (cfg.specialAreas?.length) groups.push([cfg.specialAreaTitle?.['zh-CN'] || '特殊地区', cfg.specialAreas]);
      if (cfg.adminShortcuts?.length) groups.push(['快捷州/省', cfg.adminShortcuts]);
      if (cfg.popularCities?.length) groups.push(['热门城市', cfg.popularCities]);
      for (const [title, items] of groups) {
        const t = document.createElement('div');
        t.className = 'flabel'; t.textContent = title;
        const row = document.createElement('div');
        row.className = 'chips';
        for (const sc of items) {
          const chip = document.createElement('button');
          chip.className = 'chip';
          chip.textContent = sc.label?.['zh-CN'] || sc.label?.en || sc.value;
          chip.addEventListener('click', () => applyShortcut(sc));
          row.appendChild(chip);
        }
        box.appendChild(t); box.appendChild(row);
      }
    } catch (e) { /* 快捷区加载失败不影响主功能 */ }
  }

  async function applyShortcut(sc) {
    const o = sc.option || {};
    try {
      if (o.field === 'region') {
        if ([...regionSel.options].some((x) => x.value === String(o.id))) { regionSel.value = String(o.id); onRegionChange(true); }
        toast('已选州/省：' + (sc.label?.['zh-CN'] || o.value));
      } else if (o.field === 'city') {
        if (o.regionId && [...regionSel.options].some((x) => x.value === String(o.regionId))) {
          regionSel.value = String(o.regionId); cityCombo.reset('全部城市', false); districtCombo.reset('先选城市', true); postcodeCombo.reset('先选城市', true);
        }
        cityCombo.setSelected({ id: o.id, value: o.value, label: o.value, regionId: o.regionId || null });
        toast('已选城市：' + (sc.label?.['zh-CN'] || o.value));
      }
    } catch (e) { toast('快捷选择失败：' + e.message, false); }
  }

  /* ================= 预览 / 历史 / 收藏 ================= */
  function renderPreview(d) {
    const box = panel.querySelector('#daimonna-preview');
    const rows = [
      ['姓名', d.fullName], ['名/姓', `${d.firstName} / ${d.lastName}`],
      ['邮箱', d.email], ['电话', d.phone], ['生日', d.dob],
      ['地址', d.address1], ['城市', d.city], ['州/省', `${d.state} (${d.stateCode})`],
      ['邮编', d.postcode], ['国家', `${d.countryName}`],
      ['完整地址', d.formattedAddress], ['邮寄单行', d.postalSingle],
      ['公司', d.company], ['职业', d.occupation],
      ['用户名', d.username], ['密码', d.password],
      ['测试卡', `${d.cardNetwork} ${d.cardNumber} ${d.cardExpiry} CVC ${d.cardCvc}`],
    ].filter(([, v]) => v && !String(v).includes('undefined'));
    box.innerHTML = '<div class="sect-title">当前这套（点任意行复制）</div>' + rows.map(([k, v]) =>
      `<div class="item" data-v="${esc(v)}"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')
      + (d.mapsUrl ? `<div class="item"><span class="k">地图</span><span class="v"><a href="${esc(d.mapsUrl)}" target="_blank" rel="noopener">在 Google 地图查看真实位置</a></span></div>` : '');
    box.style.display = 'block';
    box.querySelectorAll('.item[data-v]').forEach((it) => it.addEventListener('click', () => {
      GM_setClipboard(it.dataset.v); toast('已复制：' + it.dataset.v.slice(0, 40));
    }));
  }

  function renderList(el, sectEl, list, kind) {
    sectEl.style.display = list.length ? 'block' : 'none';
    el.innerHTML = '';
    list.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'hist-item';
      row.innerHTML = `<span class="info" title="${esc(d.formattedAddress)}">${esc(d.fullName)} · ${esc(d.city || '')} ${esc(d.stateCode || '')} · ${esc(d.country)}</span>`;
      const fillBtn = document.createElement('button'); fillBtn.className = 'btn small'; fillBtn.textContent = '填充';
      fillBtn.addEventListener('click', () => { setCurrent(d); doFill(d); });
      const delBtn = document.createElement('button'); delBtn.className = 'btn small'; delBtn.textContent = '删';
      delBtn.addEventListener('click', () => {
        if (kind === 'history') { history.splice(i, 1); GM_setValue('dm_history', history); renderHistory(); }
        else { favorites.splice(i, 1); GM_setValue('dm_favorites', favorites); renderFavorites(); }
      });
      row.querySelector('.info').addEventListener('click', () => setCurrent(d));
      row.appendChild(fillBtn); row.appendChild(delBtn);
      el.appendChild(row);
    });
  }
  function renderHistory() { renderList(panel.querySelector('#dm-history'), panel.querySelector('#dm-history-sect'), history, 'history'); }
  function renderFavorites() { renderList(panel.querySelector('#dm-favorites'), panel.querySelector('#dm-fav-sect'), favorites, 'fav'); }
  function setCurrent(d) { current = d; GM_setValue('dm_last', d); renderPreview(d); }
  function pushHistory(d) {
    history = [d, ...history.filter((x) => x.formattedAddress !== d.formattedAddress || x.email !== d.email)].slice(0, 10);
    GM_setValue('dm_history', history); renderHistory();
  }

  /* ================= 生成与填充 ================= */
  function doFill(d) {
    const { filled, detail } = fillForm(d, { withCard: withCardChk.checked });
    toast(filled > 0 ? `✅ 已填充 ${filled} 个字段（${[...new Set(detail)].join('、')}）` : '⚠️ 这套已生成，但本页没识别到可填充的表单字段，可点预览逐行复制', filled > 0);
    return filled;
  }

  function genOpts() {
    return { filters: currentFilters(), residential: residentialChk.checked, keyword: keywordInput.value.trim() };
  }

  async function generate(fill, extra = {}) {
    const btns = panel.querySelectorAll('.btn');
    btns.forEach((b) => b.disabled = true);
    try {
      toast('正在生成 ' + countrySel.value + ' 地址…');
      const { identity, matchLevel } = await fetchIdentity(countrySel.value, { ...genOpts(), ...extra });
      setCurrent(identity); pushHistory(identity);
      panel.classList.add('open');
      const note = matchLevel && matchLevel !== 'exact' ? '（所选地区无精确地址，已用最接近结果）' : '';
      if (fill) { doFill(identity); if (note) toast('已生成并填充' + note); }
      else toast('✅ 已生成' + note + '，点任意行可复制');
      return identity;
    } catch (e) { toast('生成失败：' + e.message, false); return null; }
    finally { btns.forEach((b) => b.disabled = false); }
  }

  async function generateBatch() {
    const btns = panel.querySelectorAll('.btn');
    btns.forEach((b) => b.disabled = true);
    let ok = 0;
    try {
      for (let i = 0; i < 5; i++) {
        toast(`批量生成中 ${i + 1}/5…`);
        try {
          const { identity } = await fetchIdentity(countrySel.value, genOpts());
          if (i === 0) setCurrent(identity);
          pushHistory(identity); ok++;
        } catch (e) { /* 单套失败跳过 */ }
      }
      panel.classList.add('open');
      toast(ok ? `✅ 批量生成完成 ${ok}/5 套，都在下方历史里，点「填充」即可用` : '批量生成全部失败，请检查网络', ok > 0);
    } finally { btns.forEach((b) => b.disabled = false); }
  }

  /* ================= 事件绑定 ================= */
  fab.addEventListener('click', () => panel.classList.toggle('open'));
  panel.querySelector('#dm-close').addEventListener('click', () => panel.classList.remove('open'));
  countrySel.addEventListener('change', () => {
    GM_setValue('dm_country', countrySel.value);
    residentialChk.checked = countrySel.value === 'CN';
    cityCombo.reset('全部城市', false); districtCombo.reset('先选城市', true); postcodeCombo.reset('先选城市', true);
    loadRegions(); renderShortcuts();
  });
  panel.querySelector('#dm-gen-fill').addEventListener('click', () => generate(true));
  panel.querySelector('#dm-gen-only').addEventListener('click', () => generate(false));
  panel.querySelector('#dm-batch').addEventListener('click', () => generateBatch());
  panel.querySelector('#dm-fill-last').addEventListener('click', () => { if (!current) return toast('还没有生成过，先点「生成并填充」', false); doFill(current); });
  panel.querySelector('#dm-copy-all').addEventListener('click', () => {
    if (!current) return toast('还没有生成过', false);
    GM_setClipboard([current.fullName, current.address1, `${current.city}, ${current.state} ${current.postcode}`, current.countryName, current.phone, current.email].filter(Boolean).join('\n'));
    toast('已复制全部信息');
  });
  panel.querySelector('#dm-fav-add').addEventListener('click', () => {
    if (!current) return toast('还没有可收藏的，先生成一套', false);
    if (favorites.some((x) => x.email === current.email && x.formattedAddress === current.formattedAddress)) return toast('这套已经在收藏里了');
    favorites = [current, ...favorites].slice(0, 20);
    GM_setValue('dm_favorites', favorites); renderFavorites();
    toast('⭐ 已收藏');
  });
  panel.querySelector('#dm-clear-hist').addEventListener('click', () => { history = []; GM_setValue('dm_history', history); renderHistory(); toast('历史已清空'); });

  panel.querySelector('#dm-ip-ctx').addEventListener('click', async () => {
    const info = panel.querySelector('#dm-ip-info');
    info.textContent = '检测中…';
    try {
      const ctx = await fetchClientContext(panel.querySelector('#dm-ip').value.trim() || undefined);
      if (!ctx) { info.textContent = '检测失败'; return; }
      info.textContent = `定位：${ctx.country || ''} · ${ctx.region || ''} · ${ctx.city || ''} · 邮编 ${ctx.postalCode || '未知'}${ctx.supported ? '' : '（该地区不支持生成）'}`;
      if (ctx.publicIp && !panel.querySelector('#dm-ip').value.trim()) panel.querySelector('#dm-ip').value = '';
    } catch (e) { info.textContent = '检测失败：' + e.message; }
  });
  panel.querySelector('#dm-ip-gen').addEventListener('click', async () => {
    const ip = panel.querySelector('#dm-ip').value.trim();
    await generate(true, { ipMode: true, ip: ip || undefined, filters: {} });
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); generate(true); }
  });

  /* ================= 初始化 ================= */
  (async function init() {
    const saved = GM_getValue('dm_filters', null);
    await loadRegions(saved && saved.country === countrySel.value ? saved.regionId : null);
    if (saved && saved.country === countrySel.value) {
      if (saved.city) { cityCombo.setSelected(saved.city); }
      if (saved.city && saved.district) districtCombo.setSelected(saved.district);
      if (saved.city && saved.postcode) postcodeCombo.setSelected(saved.postcode);
    }
    renderShortcuts();
    if (current) renderPreview(current);
    renderHistory(); renderFavorites();
  })();
})();
