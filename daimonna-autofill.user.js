// ==UserScript==
// @name         Daimonna 地址生成 · 一键自动填充
// @namespace    https://address.daimonna.com/
// @version      1.0.1
// @description  在任意网站一键调用 Daimonna 生成真实格式的身份/地址信息，并智能填充到当前页面表单（姓名/地址/城市/州省/邮编/电话/邮箱/生日/公司等）
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

  /* ================= 工具 ================= */
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

  const $ = (s, r = document) => r.querySelector(s);

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
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
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
        || opts.find(o => norm(o.textContent).startsWith(c) || c.startsWith(norm(o.textContent)) && norm(o.textContent).length >= 3);
      if (hit) { setNativeValue(sel, hit.value); return true; }
    }
    return false;
  }

  /* ================= 调用 Daimonna API ================= */
  // 接口实测（2026-11-08）：
  // GET /web-api/v1/generate?requestId={uuid}&country={CC}&residential={country==CN}&seed={uuid前12位}&strategy=instant
  // 返回 data.result.{profile, address{components}, extensions, card}
  function fetchIdentity(country) {
    return new Promise((resolve, reject) => {
      const requestId = uuid();
      const params = new URLSearchParams({
        requestId, country,
        residential: String(country === 'CN'),
        seed: requestId.slice(0, 12),
        strategy: 'instant',
      });
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${API_BASE}/v1/generate?${params}`,
        headers: { Accept: 'application/json' },
        timeout: 20000,
        onload(res) {
          try {
            const json = JSON.parse(res.responseText);
            const r = json?.data?.result;
            if (!r) return reject(new Error('接口返回异常：' + res.responseText.slice(0, 200)));
            resolve(normalize(r, country));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('网络请求失败，请检查网络')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function normalize(r, country) {
    const p = r.profile || {};
    const a = r.address || {};
    const c = a.components || {};
    const ext = r.extensions || {};
    const card = r.card || {};

    // 拆分姓名：带空格按空格拆；中日韩无空格时首字为姓
    let firstName = '', lastName = '';
    const full = (p.fullName || '').trim();
    if (full.includes(' ')) {
      const parts = full.split(/\s+/);
      // 日文名中间是空格："荻野 三郎" -> 姓在前
      if (['JP', 'CN', 'TW', 'HK', 'KR'].includes(country)) { lastName = parts[0]; firstName = parts.slice(1).join(' '); }
      else { firstName = parts[0]; lastName = parts.slice(1).join(' '); }
    } else if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(full) && full.length >= 2) {
      lastName = full.slice(0, 1); firstName = full.slice(1);
    } else { firstName = full; }

    const streetLine = [c.houseNumber, c.street].filter(Boolean).join(' ').trim()
      || c.buildingName || '';
    const address1 = [streetLine, c.buildingName && streetLine !== c.buildingName ? c.buildingName : '', c.unit].filter(Boolean).join(', ');
    const city = c.locality || c.postalLocality || c.district || '';

    return {
      country, countryName: COUNTRY_NAME[country] || country,
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
      company: ext.employment?.company || '', occupation: ext.employment?.occupation || '',
      username: ext.internet?.username || '',
      password: ext.internet?.testPassword || '',
      cardNetwork: card.network || '', cardNumber: card.number || '',
      cardExpiry: card.expiry || '', cardCvc: card.cvc || '',
    };
  }

  /* ================= 表单字段识别 ================= */
  // 顺序即优先级：越靠前越先匹配，避免 address 被 city 之类误抢
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

  // WHMCS 注册/结账表单的字段名是写死的（v6vps 等大量 VPS 商家都用 WHMCS），按 name 精确匹配最稳
  const WHMCS_NAME_MAP = {
    firstname: 'firstName', lastname: 'lastName', email: 'email',
    phonenumber: 'phone', companyname: 'company',
    address1: 'address1', address2: 'address2', city: 'city',
    state: 'state', postcode: 'postcode', country: 'country',
    password: 'password', password2: 'password',
  };

  function classifyField(el) {
    const exact = WHMCS_NAME_MAP[(el.name || '').toLowerCase()];
    if (exact) return exact;
    const ac = (el.getAttribute('autocomplete') || '').trim();
    const hay = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelTextOf(el)].filter(Boolean).join(' ');
    for (const [key, re, acRe] of FIELD_RULES) {
      if (ac && acRe.test(ac)) return key;
    }
    for (const [key, re] of FIELD_RULES) {
      if (re.test(hay)) return key;
    }
    // type 兜底
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
    // WHMCS 等站对密码有最低长度要求（字段上带 data-min-length）：统一补足一次，
    // 保证密码框和确认密码框填的是同一个值
    const pwdMin = Math.max(0, ...[...document.querySelectorAll('input[type="password"]')]
      .map((e) => parseInt(e.getAttribute('data-min-length') || '0', 10) || 0));
    if (values.password && pwdMin && values.password.length < pwdMin) {
      const pad = 'Aa1!xY9#Qq2@';
      let v = values.password;
      while (v.length < pwdMin) v += pad[v.length % pad.length];
      values.password = v;
    }
    // v1.0.0 的过滤表达式写错了优先级（?: 兜底把结果反转），正常输入框全被误杀、任何站都填不了，v1.0.1 修正
    const SKIP_TYPES = ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'];
    const els = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
      if (el.closest('#daimonna-panel')) return false;
      if (SKIP_TYPES.includes(el.type)) return false;
      if (el.disabled || el.readOnly) return false;
      if (el.offsetParent === null) return false; // 不可见（弹窗里的隐藏字段等）
      return true;
    });

    let filled = 0; const detail = [];
    const usedFullNameFallback = new Set();
    for (const el of els) {
      if (el.offsetParent === null && el.type !== 'hidden') continue;
      let key = classifyField(el);
      if (!key) continue;
      // 只有 fullName 字段、没有 first/last 拆分字段时的兜底在下面处理
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
        // 姓名兜底：页面只有一个姓名类字段时用全名
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
    #daimonna-panel{position:fixed;right:18px;bottom:66px;z-index:2147483646;width:340px;max-width:calc(100vw - 24px);background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.22);font-size:13px;overflow:hidden;display:none;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}
    #daimonna-panel.open{display:block}
    #daimonna-panel header{display:flex;justify-content:space-between;align-items:center;background:#eff6ff;padding:10px 12px;font-weight:700;}
    #daimonna-panel header button{background:none;border:none;cursor:pointer;font-size:16px;color:#6b7280;}
    #daimonna-panel .body{padding:12px;display:flex;flex-direction:column;gap:9px;max-height:62vh;overflow:auto;}
    #daimonna-panel select,#daimonna-panel .row{display:flex;gap:8px;align-items:center;}
    #daimonna-panel select{width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;background:#fff;}
    #daimonna-panel .btn{flex:1;padding:9px 6px;border-radius:9px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-weight:600;}
    #daimonna-panel .btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}
    #daimonna-panel .btn:disabled{opacity:.55;cursor:wait;}
    #daimonna-panel label.chk{display:flex;gap:6px;align-items:center;color:#374151;cursor:pointer;}
    #daimonna-preview{border-top:1px dashed #e5e7eb;padding-top:8px;display:none;}
    #daimonna-preview.show{display:block}
    #daimonna-preview .item{display:flex;gap:6px;padding:3px 0;cursor:pointer;border-radius:6px;}
    #daimonna-preview .item:hover{background:#f3f4f6;}
    #daimonna-preview .k{color:#6b7280;flex:0 0 64px;}
    #daimonna-preview .v{word-break:break-all;font-weight:500;}
    #daimonna-panel .hint{color:#9ca3af;font-size:12px;line-height:1.5;}
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
      <select id="dm-country">${COUNTRIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select>
      <div class="row">
        <button class="btn primary" id="dm-gen-fill">⚡ 生成并填充</button>
        <button class="btn" id="dm-gen-only">仅生成预览</button>
      </div>
      <div class="row">
        <button class="btn" id="dm-fill-last">填充上次生成</button>
        <button class="btn" id="dm-copy-all">复制全部信息</button>
      </div>
      <label class="chk"><input type="checkbox" id="dm-with-card"> 同时填充测试银行卡（卡号/有效期/CVC）</label>
      <div id="daimonna-preview"></div>
      <div class="hint">快捷键 Alt+Shift+F 快速生成并填充。点击预览里的任意一行可单独复制。生成的数据来自 address.daimonna.com，银行卡为测试数据、请勿用于真实支付。</div>
    </div>`;
  document.body.appendChild(panel);

  const sel = panel.querySelector('#dm-country');
  sel.value = GM_getValue('dm_country', 'US');
  sel.addEventListener('change', () => GM_setValue('dm_country', sel.value));
  panel.querySelector('#dm-with-card').checked = GM_getValue('dm_with_card', false);
  panel.querySelector('#dm-with-card').addEventListener('change', (e) => GM_setValue('dm_with_card', e.target.checked));

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  panel.querySelector('#dm-close').addEventListener('click', () => panel.classList.remove('open'));

  let lastIdentity = GM_getValue('dm_last', null);

  function renderPreview(d) {
    const box = panel.querySelector('#daimonna-preview');
    const rows = [
      ['姓名', d.fullName], ['名/姓', `${d.firstName} / ${d.lastName}`],
      ['邮箱', d.email], ['电话', d.phone], ['生日', d.dob],
      ['地址', d.address1], ['城市', d.city], ['州/省', `${d.state} (${d.stateCode})`],
      ['邮编', d.postcode], ['国家', `${d.countryName}`],
      ['完整地址', d.formattedAddress], ['公司', d.company], ['职业', d.occupation],
      ['用户名', d.username], ['密码', d.password],
      ['测试卡', `${d.cardNetwork} ${d.cardNumber} ${d.cardExpiry} CVC ${d.cardCvc}`],
    ].filter(([, v]) => v);
    box.innerHTML = rows.map(([k, v]) => `<div class="item" data-v="${String(v).replace(/"/g, '&quot;')}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
    box.classList.add('show');
    box.querySelectorAll('.item').forEach(it => it.addEventListener('click', () => {
      GM_setClipboard(it.dataset.v); toast('已复制：' + it.dataset.v.slice(0, 40));
    }));
  }
  if (lastIdentity) renderPreview(lastIdentity);

  async function generate(fill) {
    const btns = panel.querySelectorAll('.btn');
    btns.forEach(b => b.disabled = true);
    try {
      toast('正在生成 ' + sel.value + ' 地址…');
      const data = await fetchIdentity(sel.value);
      lastIdentity = data;
      GM_setValue('dm_last', data);
      renderPreview(data);
      panel.classList.add('open');
      if (fill) {
        const { filled, detail } = fillForm(data, { withCard: panel.querySelector('#dm-with-card').checked });
        toast(filled > 0 ? `✅ 已填充 ${filled} 个字段（${[...new Set(detail)].join('、')}）` : '⚠️ 生成成功，但本页没识别到可填充的表单字段，可点预览逐行复制', filled > 0);
      } else {
        toast('✅ 已生成，点任意行可复制');
      }
    } catch (e) {
      toast('生成失败：' + e.message, false);
    } finally { btns.forEach(b => b.disabled = false); }
  }

  panel.querySelector('#dm-gen-fill').addEventListener('click', () => generate(true));
  panel.querySelector('#dm-gen-only').addEventListener('click', () => generate(false));
  panel.querySelector('#dm-fill-last').addEventListener('click', () => {
    if (!lastIdentity) return toast('还没有生成过，先点「生成并填充」', false);
    const { filled } = fillForm(lastIdentity, { withCard: panel.querySelector('#dm-with-card').checked });
    toast(filled > 0 ? `✅ 已用上次数据填充 ${filled} 个字段` : '⚠️ 本页没识别到可填充的字段', filled > 0);
  });
  panel.querySelector('#dm-copy-all').addEventListener('click', () => {
    if (!lastIdentity) return toast('还没有生成过', false);
    const d = lastIdentity;
    GM_setClipboard([d.fullName, d.address1, `${d.city}, ${d.state} ${d.postcode}`, d.country, d.phone, d.email].filter(Boolean).join('\n'));
    toast('已复制全部信息');
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); generate(true); }
  });
})();
