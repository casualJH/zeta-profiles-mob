// ==UserScript==
// @name         제타 프로필 자동감지 (모브 프로필 사진 추가)
// @namespace    zeta-current-profiles
// @version      1.0.2
// @description  채팅방의 현재 캐릭터/유저 대화 프로필을 수집해 프로필 카드로 표시합니다.
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @noframes
// @sandbox      raw
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  if (window.__zetaCurrentProfilesTest01) return;
  window.__zetaCurrentProfilesTest01 = true;

  const API = 'https://api.zeta-ai.io';
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const MAX_TEXT = 20000;
  const MAX_JSON_BYTES = 900000;
  const state = {roomId: null, character: null, chatProfile: null, user: null, personaStatus: '미확인', lastUrl: location.pathname + location.search};
  // Add a path here only after verifying the field against a real response.
  const confirmedFields = [['description']];
  const detailSources = new Map();
  const screenProfiles = new Map();
  const plotIntroductions = new Map();
  let roomCharacters = [];
  let panel, output;
  let roomGeneration = 0;
  let refreshPending = false;

  function roomFromText(text) {
    const match = /\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(String(text || ''));
    return match && UUID.test(match[1]) ? match[1] : null;
  }
  function onRoom(id) {
    if (!id || id === state.roomId) return;
    roomGeneration++;
    state.roomId = id;
    state.plotId = null;
    detailSources.clear();
    roomCharacters = [];
    screenProfiles.clear();
    plotIntroductions.clear();
    state.character = null;
    state.chatProfile = null;
    state.user = null;
    state.personaStatus = '미확인';
    renderSoon();
  }
  function checkRoute() {
    const url = location.pathname + location.search;
    if (url !== state.lastUrl) {
      state.lastUrl = url;
      const id = roomFromText(url);
      if (id) onRoom(id);
      else if (state.roomId) {
        roomGeneration++;
        state.roomId = null;
        state.plotId = null;
        roomCharacters = [];
        screenProfiles.clear();
        plotIntroductions.clear();
        detailSources.clear();
        state.character = null;
        state.chatProfile = null;
        state.user = null;
        state.personaStatus = '미확인';
        renderSoon();
      }
    }
    const id = roomFromText(url);
    if (id) onRoom(id);
  }
  function endpoint(raw) {
    try {
      const u = new URL(String(raw), location.href);
      if (u.origin !== API) return null;
      return u.pathname;
    } catch (_) { return null; }
  }
  function rawUrl(input) {
    try { return typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url; }
    catch (_) { return ''; }
  }
  function plain(value, max = MAX_TEXT) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }
  function profileObject(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    // The API may return empty strings, nulls, or nested values. Only actual
    // nonempty strings are accepted as displayed profile data.
    const name = ['name', 'displayName', 'display_name', 'nickname', 'title'].map(k => obj[k]).find(v => typeof v === 'string' && v.trim());
    const desc = typeof obj.description === 'string' ? obj.description : '';
    const avatar = ['avatarUrl', 'avatar_url', 'profileImageUrl', 'profile_image_url', 'imageUrl', 'image_url', 'thumbnailUrl', 'thumbnail_url'].map(k => obj[k]).find(v => typeof v === 'string' && /^https?:\/\//.test(v));
    const id = ['id', 'uuid', 'profileId', 'profile_id', 'characterId', 'character_id'].map(k => obj[k]).find(v => typeof v === 'string' || typeof v === 'number');
    if (!name && !desc && !avatar) return null;
    return {id: id == null ? null : String(id).slice(0, 120), name: plain(name, 160), description: desc, image: plain(avatar, 1200)};
  }
  function visit(root, callback) {
    const stack = [{ value: root, path: '$', depth: 0 }];
    for (let count = 0; stack.length && count < 1500; count++) {
      const item = stack.pop();
      callback(item.value, item.path);
      if (!item.value || typeof item.value !== 'object' || item.depth >= 10) continue;
      const array = Array.isArray(item.value);
      const keys = Object.keys(item.value).slice(0, 100);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        if (/auth|token|cookie|password|secret|email|phone/i.test(key)) continue;
        const path = array ? item.path + '[' + key + ']' : item.path + '.' + key;
        stack.push({ value: item.value[key], path, depth: item.depth + 1 });
      }
    }
  }

  function accept(type, match, path) {
    if (!match) return;
    const previous = state[type];
    // 같은 방에서 응답에 새 프로필이 나타나면 갱신
    if (previous && JSON.stringify(previous.data) === JSON.stringify(match.profile)) return;
    state[type] = {data:match.profile, origin:path, field:match.path, at:new Date().toISOString()};
    renderSoon();
    window.dispatchEvent(new CustomEvent('zeta-current-profiles-updated', {detail:publicState()}));
  }
  function publicState() {
    return {roomId:state.roomId, character:state.character?.data || null, chatProfile:state.chatProfile?.data || null, user:state.user?.data || null, userPersonaStatus:state.personaStatus};
  }
  // 웹페이지에서 다른 유저스크립트가 사용할 수 있는 읽기 전용 스냅샷 API
  Object.defineProperty(window, 'zetaCurrentProfiles', {configurable:false, enumerable:false, value:Object.freeze({get:publicState})});

  function observe(path, payload, status) {
    const isPersonaSelect = /^\/v1\/plots\/[^/]+\/rooms\/[^/]+\/user-personas\/(select|selected)\/?$/i.test(path);
    if (isPersonaSelect && payload === null && status === 200 && roomFromText(path) === state.roomId) {
      state.user = null;
      state.personaStatus = '선택된 프로필 없음';
      renderSoon();
    }
    if (!state.roomId || !path || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const requestRoom = roomFromText(path);
    const isMessage = /\/messages(?:\/|$)/i.test(path);
    const isRoomDetail = !!requestRoom && !isMessage;
    const isRelated = isRoomDetail || /(?:profile|persona|character|bot|agent|\/plots\/)/i.test(path);
    if (!isRelated) return;
    if (isRoomDetail && !state.roomId) onRoom(requestRoom);
    // 다른 방에서 로드된 응답으로 현재 프로필을 덮어쓰지 않음
    if (requestRoom && requestRoom !== state.roomId) return;
    // This endpoint is room-scoped, even though it also contains a plot ID.
    if (isPersonaSelect) {
      const persona = profileObject(payload);
      if (persona) {
        state.personaStatus='선택 API에서 프로필 데이터 감지';
        accept('user',{profile:persona,path:'$'},path);
      } else {
        state.personaStatus='선택 API에서 표시 가능한 프로필 데이터 없음';
      }
      return;
    }
    const plotId = /\/plots\/([0-9a-f-]{36})(?:\/|$)/i.exec(path);
    const relatedPlot = plotId && state.plotId && plotId[1] === state.plotId;
    if (!isRoomDetail && !relatedPlot && !plotId && !/profile|character/i.test(path)) return;
    if (plotId && state.plotId && !relatedPlot) return;
    if (plotId && path.replace(/\/$/, '') === '/v1/plots/' + plotId[1] &&
        payload.id === plotId[1] && Array.isArray(payload.about?.characters)) {
      const introductions = new Map();
      for (const entry of payload.about.characters) {
        if (entry && typeof entry.characterId === 'string' &&
            typeof entry.description === 'string' && entry.description.trim()) {
          introductions.set(entry.characterId, entry.description);
        }
      }
      plotIntroductions.set(payload.id, introductions);
      renderSoon();
    }
    // A room detail directly identifies its plot. Accept a unique plot character
    // as a room-linked candidate, without treating it as a verified chat speaker.
    if (/^\/v1\/rooms\/[0-9a-f-]{36}\/?$/i.test(path) && payload.plot && typeof payload.plot === 'object') {
      state.plotId = typeof payload.plot.id === 'string' ? payload.plot.id : null;
      const chars = payload.plot.characters;
      roomCharacters = Array.isArray(chars) ? chars.map(profileObject).filter(Boolean) : [];
      renderSoon();
      if (Array.isArray(chars) && chars.length === 1) {
        const candidate = profileObject(chars[0]);
        if (state.character && state.character.data.id !== candidate?.id) detailSources.clear();
        if (candidate) accept('character', {profile:candidate, path:'$.plot.characters[0]'}, path);
      } else if (Array.isArray(chars)) {
        state.character = null;
        detailSources.clear();
      }
      const profiles = payload.plot.chatProfiles;
      if (Array.isArray(profiles) && profiles.length === 1) {
        const chat = profileObject(profiles[0]);
        if (chat) accept('chatProfile', {profile:chat, path:'$.plot.chatProfiles[0]'}, path);
      }
    }
    if (!/\/(messages|events|recommended-messages|settings|model-setting)(?:\/|$)/i.test(path)) {
      collectDetails(path, payload);
    }
  }

  function collectDetails(path, payload) {
    const character = state.character;
    const id = character && character.data.id;
    if (!id) return;
    const base = /^\/v1\/rooms\/[^/]+\/?$/i.test(path);
    visit(payload, (value, field) => {
      if (!value || typeof value !== 'object' || value.id !== id) return;
      for (const parts of confirmedFields) {
        const text = parts.reduce((node, key) =>
          node && Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined, value);
        if (typeof text !== 'string' || !text.trim()) continue;
        const key = parts.join('.');
        const previous = detailSources.get(key);
        if (base && previous && previous.id === id && !previous.base) continue;
        detailSources.set(key, {id, base, text, origin: path, field: field + '.' + key});
      }
    });
    applyDetails(character);
    collectVisibleDescription();
  }

  function applyDetails(character) {
    const id = character.data.id;
    const details = Array.from(detailSources.values()).filter(entry => entry.id === id)
      .sort((a, b) => Number(!!b.screen) - Number(!!a.screen))
      .map(({text, origin, field}) => ({text, origin, field}));
    character.details = details;
    if (details.length) character.data.description = details[0].text;
    character.descriptionStatus = details.length ? '원문 수집됨' : '본문 미확인';
    renderSoon();
    window.dispatchEvent(new CustomEvent('zeta-current-profiles-updated', {detail:publicState()}));
  }
  const descriptionSelector = '[data-sentry-component="CharacterDescription"]';
  function collectVisibleDescription() {
    checkRoute();
    if (!state.roomId) return;
    let character = state.character;
    const candidates = [];
    for (const title of document.querySelectorAll('h3, [role="heading"]')) {
      const name = title.textContent.trim();
      if (!name) continue;
      const header = title.parentElement;
      const close = header.querySelector('button[aria-label="Close"], button[aria-label="닫기"]');
      if (!close || !close.getClientRects().length) continue;
      const overlay = header.parentElement;
      if (!overlay || overlay.closest('[aria-hidden="true"], [hidden]')) continue;
      const sections = Array.from(overlay.children).filter(section =>
        section !== header && section.getClientRects().length);
      const known = sections.filter(section => section.matches(descriptionSelector));
      const allowFallback = character?.data.name.trim() === name ||
        roomCharacters.filter(profile => profile.name.trim() === name).length === 1;
      for (const section of known.length || !allowFallback ? known : sections) {
        const body = section.matches('.whitespace-pre-wrap') ? section :
          section.querySelector('.whitespace-pre-wrap');
        if (!body || body.closest('[aria-hidden="true"], [hidden]') ||
            !body.getClientRects().length || !body.innerText.trim()) continue;
        candidates.push({body, name, known: section.matches(descriptionSelector)});
      }
    }
    if (candidates.length !== 1) return;
    const {body, known, name} = candidates[0];
    const text = body.innerText;
    if (!text.trim()) return;
    const matching = roomCharacters.filter(profile => profile.name.trim() === name);
    if (matching.length > 1) return;
    const images = new Set(Array.from(document.querySelectorAll('[aria-label="Chat messages"] img'))
      .filter(image => image.alt === name).map(image => image.currentSrc || image.src).filter(Boolean));
    const image = matching[0]?.image || (images.size === 1 ? images.values().next().value : '');
    const previous = screenProfiles.get(name);
    if (previous?.description !== text || previous?.image !== image) {
      screenProfiles.set(name, {id:matching[0]?.id || null, name, description:text, image});
      renderSoon();
    }
    if (roomCharacters.length > 1 || (character && character.data.name.trim() !== name) ||
        (character && detailSources.get('screen')?.text === text)) return;
    if (!character) {
      character = {data: {id:null, name, description:'', image:''},
        origin:'캐릭터 상세 화면', field:descriptionSelector, at:new Date().toISOString()};
      state.character = character;
    }
    detailSources.set('screen', {id: character.data.id, screen: true, text,
      origin: '캐릭터 상세 화면', field: known ? descriptionSelector + ' .whitespace-pre-wrap' : '캐릭터 상세 본문'});
    applyDetails(character);
  }

  function inspectResponse(resp, path, room) {
    if (!path || !resp) return;
    if (!resp.ok) return;
    const length = Number(resp.headers.get('content-length'));
    if (length && length > MAX_JSON_BYTES) return;
    const contentType = resp.headers.get('content-type') || '';
    if (!/json/i.test(contentType) && !path.toLowerCase().includes('/user-personas/select')) return;
    resp.clone().text().then(text => {
      if (text.length > MAX_JSON_BYTES) return;
      if (room !== roomGeneration) return;
      observe(path, JSON.parse(text), resp.status);
    }).catch(() => {});
  }
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    checkRoute();
    const path = endpoint(rawUrl(input));
    if (path) {
      const id = roomFromText(path);
      if (id && !state.roomId) onRoom(id);
    }
    const room = roomGeneration;
    const response = nativeFetch.apply(this, arguments);
    if (path && (/\/rooms\//.test(path) || /profile|persona|character|bot|agent|\/plots\//i.test(path))) {
      Promise.resolve(response).then(r => inspectResponse(r, path, room)).catch(() => {});
    }
    return response;
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    const path = endpoint(url);
    xhrInfo.set(this, path);
    if (path && !state.roomId) onRoom(roomFromText(path));
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    checkRoute();
    const room = roomGeneration;
    const path = xhrInfo.get(this);
    if (path && (/\/rooms\//.test(path) || /profile|persona|character|bot|agent|\/plots\//i.test(path))) {
      this.addEventListener('load', function () {
        if (room !== roomGeneration) return;
        try {
          if (this.status < 200 || this.status >= 300) return;
          let payload;
          if (this.responseType === 'json') payload = this.response;
          else if (this.responseType === '' || this.responseType === 'text') {
            const text = this.responseText;
            if (typeof text !== 'string' || text.length > MAX_JSON_BYTES) return;
            payload = JSON.parse(text);
          } else return;
          observe(path, payload, this.status);
        } catch (_) {}
      }, {once:true});
    }
    return nativeSend.apply(this, arguments);
  };

  function renderSoon() {
    if (refreshPending) return;
    refreshPending = true;
    setTimeout(() => {refreshPending=false; render();}, 120);
  }
  let renderedProfiles = '';
  let expansionRoom;
  let expandAll;
  let previews = [];
  const expandedProfiles = new Set();

  function updatePreviews() {
    const long = previews.filter(({body}) =>
      body.scrollHeight > parseFloat(getComputedStyle(body).lineHeight) * 3 + 1);
    const allExpanded = long.length > 0 && long.every(({key}) => expandedProfiles.has(key));
    expandAll.hidden = !long.length;
    expandAll.textContent = allExpanded ? '모두 접기' : '모두 펼치기';
    for (const preview of previews) {
      const expanded = expandedProfiles.has(preview.key);
      preview.toggle.hidden = !long.includes(preview);
      preview.toggle.textContent = expanded ? '접기' : '+ 더보기';
      preview.toggle.setAttribute('aria-expanded', String(expanded));
      preview.body.classList.toggle('zcp-preview', !expanded);
    }
  }
  function listedCharacters() {
    const profiles = roomCharacters.map(profile => {
      const name = profile.name.trim();
      const screen = roomCharacters.filter(entry => entry.name.trim() === name).length === 1 &&
        screenProfiles.get(name);
      const detail = profile.id && state.character?.data.id === profile.id ? state.character.data : profile;
      const introduction = plotIntroductions.get(state.plotId)?.get(profile.id);
      return {...detail, description:screen?.description || introduction || detail.description,
        image:detail.image || screen?.image || ''};
    });
    if (!profiles.length) {
      profiles.push(...screenProfiles.values());
      if (!profiles.length && state.character) profiles.push(state.character.data);
    }
    return profiles;
  }

  function render() {
    if (!output || panel.hidden) return;
    const characters = listedCharacters();
    const user = state.user?.data;
    const signature = JSON.stringify([state.roomId, user, characters]);
    if (signature === renderedProfiles) {
      updatePreviews();
      return;
    }
    if (expansionRoom !== state.roomId) {
      expansionRoom = state.roomId;
      expandedProfiles.clear();
    }
    previews = [];
    renderedProfiles = signature;
    output.replaceChildren();

    function section(title, profiles, empty, missingBody) {
      const heading = document.createElement('h2');
      heading.textContent = title;
      output.appendChild(heading);
      if (!profiles.length) {
        const message = document.createElement('p');
        message.textContent = empty;
        output.appendChild(message);
      }
      for (const [index, profile] of profiles.entries()) {
        const card = document.createElement('article');
        const header = document.createElement('header');
        const name = document.createElement('h3');
        name.textContent = profile.name || '이름 미확인';
        const avatar = document.createElement('span');
        avatar.className = 'zcp-avatar';
        if (/^https:\/\//i.test(profile.image || '')) {
          const image = document.createElement('img');
          image.src = profile.image;
          image.alt = '';
          avatar.appendChild(image);
        } else {
          avatar.textContent = name.textContent.slice(0, 1);
        }
        header.append(avatar, name);
        const body = document.createElement('div');
        body.className = 'zcp-body';
        body.textContent = profile.description || missingBody;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'zcp-more';
        const key = title.split(' ')[0] + ':' + (profile.id || profile.name + ':' + index);
        body.id = 'zcp-description-' + previews.length;
        toggle.setAttribute('aria-controls', body.id);
        toggle.addEventListener('click', () => {
          if (expandedProfiles.has(key)) expandedProfiles.delete(key);
          else expandedProfiles.add(key);
          updatePreviews();
        });
        previews.push({body, toggle, key});
        card.append(header, body, toggle);
        output.appendChild(card);
      }
    }

    section('유저 프로필', user ? [user] : [], '선택된 유저 프로필을 기다리는 중', '등록된 본문이 없습니다.');
    section('등장인물 ' + characters.length, characters,
      '채팅에서 캐릭터의 [프로필 사진]을 눌러 주세요.',
      '채팅에서 이 캐릭터의 [프로필 사진]을 누르면 본문이 표시됩니다.');
    updatePreviews();
  }
  function makeUI() {
    if (!document.body || document.getElementById('zcp-launch')) return;
    const style = document.createElement('style');
    style.textContent = `
      #zcp-panel,#zcp-launch{color-scheme:dark}
      #zcp-panel[data-theme="light"],#zcp-launch[data-theme="light"]{color-scheme:light;--zcp-panel:#fff;--zcp-text:#242531;--zcp-launch:#f7f7fb;--zcp-control-line:#8a8d9d;--zcp-line:#c5c7d3;--zcp-divider:#dedfe8;--zcp-button:#ededf5;--zcp-button-line:#a1a4b5;--zcp-muted:#505367;--zcp-card:#f3f3f8;--zcp-avatar:#e2e4ef;--zcp-body:#383a49;--zcp-accent:#535873;--zcp-card-line:#c5c7d3;--zcp-form:#eeeef5;--zcp-input:#fff;--zcp-file:#383a49;--zcp-hint:#505367;}
      #zcp-panel .zcp-title-controls{display:flex;align-items:center;gap:6px;margin-inline-start:auto;flex:none}
      #zcp-panel #zcp-theme{min-width:38px;font-size:18px;line-height:1}
      #zcp-launch{touch-action:none;user-select:none;position:fixed;right:12px;bottom:calc(92px + env(safe-area-inset-bottom));z-index:2147483600;background:var(--zcp-launch, #292934);color:var(--zcp-text, #fff);border:1px solid var(--zcp-control-line, #777);border-radius:20px;padding:9px 12px;font:13px system-ui,-apple-system,sans-serif;box-shadow:0 3px 12px #0004}
      #zcp-panel{position:fixed;right:16px;bottom:calc(85px + env(safe-area-inset-bottom, 0px));width:min(380px,calc(100vw - 24px));height:540px;max-height:calc(100vh - 105px);max-height:calc(100dvh - 105px - env(safe-area-inset-bottom, 0px));display:flex;flex-direction:column;overflow:hidden;z-index:2147483601;background:var(--zcp-panel, #141416);color:var(--zcp-text, #fff);border:1px solid var(--zcp-line, #454650);border-radius:14px;box-sizing:border-box;font:15px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 12px 45px #0005}
      #zcp-panel .zcp-titlebar{flex:none;align-items:center;padding:9px 12px;border-bottom:1px solid var(--zcp-divider, #33343a);cursor:grab;touch-action:none}
      #zcp-panel .zcp-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 12px 16px}
      @media(max-width:420px){#zcp-panel{right:12px}}
      #zcp-panel[hidden]{display:none!important}#zcp-panel button{padding:8px 10px;background:var(--zcp-button, #393946);color:var(--zcp-text, #fff);border:1px solid var(--zcp-button-line, #696977);border-radius:7px;cursor:pointer}
      #zcp-output{margin:12px 0;overflow-wrap:anywhere}
      #zcp-output h2{font-size:15px;color:var(--zcp-muted, #b9bac2);margin:18px 0 8px}
      #zcp-output article{background:var(--zcp-card, #202124);border-radius:18px;padding:18px;margin-bottom:14px}
      #zcp-output header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
      #zcp-output h3{font-size:17px;margin:0}
      #zcp-output .zcp-avatar{display:grid;place-items:center;width:52px;height:52px;flex:none;border-radius:50%;overflow:hidden;background:var(--zcp-avatar, #34353a);font-weight:700}
      #zcp-output .zcp-avatar img{display:block;width:100%;height:100%;object-fit:cover}
      #zcp-output .zcp-body{white-space:pre-wrap;font-size:15px;line-height:1.65;color:var(--zcp-body, #e3e3e8)}
      #zcp-output .zcp-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;max-height:4.95em}
      #zcp-output .zcp-more{background:none;border:0;text-decoration:underline;color:var(--zcp-muted, #b9bac2);padding:4px 0;margin-top:3px}
      #zcp-panel [hidden]{display:none!important}
      #zcp-panel .zcp-grip{position:absolute;right:0;bottom:0;width:30px;height:30px;cursor:nwse-resize;touch-action:none;padding:0;background:transparent;border:0;border-radius:0}
      #zcp-panel .zcp-grip::after{content:'';position:absolute;right:3px;bottom:3px;width:13px;height:13px;background:var(--zcp-accent, #eee);clip-path:polygon(100% 0,100% 100%,0 100%);pointer-events:none}
      #zcp-panel .zcp-grip:focus-visible{outline:2px solid var(--zcp-accent, #eee);outline-offset:-3px}
      #zcp-panel .zcp-expand-all{display:block;flex:none;align-self:stretch;width:auto;min-width:0;box-sizing:border-box;margin:12px;background:var(--zcp-card, #202124);border-color:var(--zcp-card-line, #38393d)}
      #zcp-panel .zcp-actions{display:flex;gap:6px;flex-wrap:wrap}
    `;
    document.head.appendChild(style);
    const launch = document.createElement('button');
    launch.id='zcp-launch'; launch.type='button'; launch.textContent='프로필';
    panel=document.createElement('section'); panel.id='zcp-panel'; panel.hidden=true;
    const title=document.createElement('strong');title.textContent='현재 채팅 프로필';
    const close=document.createElement('button');close.type='button';close.textContent='닫기';close.addEventListener('click',()=>panel.hidden=true);
    const top=document.createElement('div');top.className='zcp-actions';top.style.justifyContent='space-between';top.append(title,close);
    const themeKey = 'zeta-profiles-mob:theme';
    const prefersDark = matchMedia('(prefers-color-scheme: dark)');
    const theme = document.createElement('button');
    theme.id = 'zcp-theme';
    theme.type = 'button';
    let mode = 'auto';
    try {
      const savedTheme = localStorage.getItem(themeKey);
      if (savedTheme === 'light' || savedTheme === 'dark') mode = savedTheme;
    } catch (_) {}
    function isDark() {
      return mode === 'dark' || (mode === 'auto' && prefersDark.matches);
    }
    function applyTheme() {
      const dark = isDark();
      launch.dataset.theme = panel.dataset.theme = dark ? 'dark' : 'light';
      theme.textContent = dark ? '☀' : '☾';
      theme.title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
      theme.setAttribute('aria-label', theme.title);
    }
    theme.addEventListener('click', () => {
      mode = isDark() ? 'light' : 'dark';
      try { localStorage.setItem(themeKey, mode); } catch (_) {}
      applyTheme();
    });
    prefersDark.addEventListener('change', applyTheme);
    const controls = document.createElement('div');
    controls.className = 'zcp-title-controls';
    controls.append(theme, close);
    top.append(controls);
    applyTheme();
    renderedProfiles = '';
    output=document.createElement('div');output.id='zcp-output';
    expandAll = document.createElement('button');
    expandAll.type = 'button';
    expandAll.hidden = true;
    expandAll.addEventListener('click', () => {
      const long = previews.filter(({toggle}) => !toggle.hidden);
      const allExpanded = long.every(({key}) => expandedProfiles.has(key));
      for (const {key} of long) {
        if (allExpanded) expandedProfiles.delete(key);
        else expandedProfiles.add(key);
      }
      updatePreviews();
    });
    expandAll.className = 'zcp-expand-all';
    top.classList.add('zcp-titlebar');
    const scroll = document.createElement('div');
    scroll.className = 'zcp-scroll';
    const mobOutput = document.createElement('div');
    mobOutput.id = 'zmp-output';
    scroll.append(output, mobOutput);
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'zcp-grip';
    grip.setAttribute('aria-label', '창 크기 조절');
    panel.append(top, expandAll, scroll, grip);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (!panel.hidden) updatePreviews(); }).observe(scroll);
    }
    const geometryKey = 'zeta-current-profiles:window';
    let savedGeometry;
    try { savedGeometry = JSON.parse(localStorage.getItem(geometryKey)); } catch (_) {}

    function saveGeometry() {
      const {left, top, width, height} = panel.getBoundingClientRect();
      if (!width || !height) return;
      savedGeometry = {left, top, width, height};
      try { localStorage.setItem(geometryKey, JSON.stringify(savedGeometry)); } catch (_) {}
    }

    function restoreGeometry() {
      if (!savedGeometry) return;
      const {left, top, width, height} = savedGeometry;
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const fittedWidth = Math.min(innerWidth - 16, Math.max(220, width));
      const fittedHeight = Math.min(innerHeight - 16, Math.max(180, height));
      panel.style.right = panel.style.bottom = 'auto';
      panel.style.maxHeight = 'none';
      panel.style.width = fittedWidth + 'px';
      panel.style.height = fittedHeight + 'px';
      panel.style.left = Math.max(8, Math.min(innerWidth - fittedWidth - 8, left)) + 'px';
      panel.style.top = Math.max(8, Math.min(innerHeight - fittedHeight - 8, top)) + 'px';
    }

    function resize(bounds, width, height) {
      panel.style.right = panel.style.bottom = 'auto';
      panel.style.left = bounds.left + 'px';
      panel.style.top = bounds.top + 'px';
      panel.style.maxHeight = 'none';
      panel.style.width = Math.min(innerWidth - bounds.left, Math.max(220, width)) + 'px';
      panel.style.height = Math.min(innerHeight - bounds.top, Math.max(180, height)) + 'px';
      updatePreviews();
    }
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const bounds = panel.getBoundingClientRect();
      grip.setPointerCapture(event.pointerId);
      const move = pointer => resize(bounds, bounds.width + pointer.clientX - event.clientX,
        bounds.height + pointer.clientY - event.clientY);
      grip.addEventListener('pointermove', move);
      grip.addEventListener('lostpointercapture', () => { grip.removeEventListener('pointermove', move); saveGeometry(); }, {once:true});
    });
    grip.addEventListener('keydown', event => {
      const offsets = {ArrowLeft:[-16,0], ArrowRight:[16,0], ArrowUp:[0,-16], ArrowDown:[0,16]};
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault();
      const bounds = panel.getBoundingClientRect();
      resize(bounds, bounds.width + offset[0], bounds.height + offset[1]);
      saveGeometry();
    });
    top.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const bounds = panel.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      top.setPointerCapture(event.pointerId);
      function move(pointer) {
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = Math.max(0, Math.min(innerWidth - bounds.width, pointer.clientX - x)) + 'px';
        panel.style.top = Math.max(0, Math.min(innerHeight - bounds.height, pointer.clientY - y)) + 'px';
      }
      top.addEventListener('pointermove', move);
      top.addEventListener('lostpointercapture', () => { top.removeEventListener('pointermove', move); saveGeometry(); }, {once:true});
    });
    window.addEventListener('resize', restoreGeometry);
    restoreGeometry();
    document.body.append(launch,panel);
    const launchKey = 'zeta-profiles-mob:launch-position';
    let launchPosition;
    try { launchPosition = JSON.parse(localStorage.getItem(launchKey)); } catch (_) {}
    function positionLaunch(left, top) {
      const x = Math.max(0, Math.min(innerWidth - launch.offsetWidth, left));
      const y = Math.max(0, Math.min(innerHeight - launch.offsetHeight, top));
      Object.assign(launch.style, {left:x+'px', top:y+'px', right:'auto', bottom:'auto'});
      return {left:x, top:y};
    }
    function restoreLaunch() {
      if (Number.isFinite(launchPosition?.left) && Number.isFinite(launchPosition?.top)) {
        positionLaunch(launchPosition.left, launchPosition.top);
      }
    }
    restoreLaunch();
    window.addEventListener('resize', restoreLaunch);

    let drag;
    let suppressClick = false;
    launch.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      const {left, top} = launch.getBoundingClientRect();
      drag = {id:event.pointerId, x:event.clientX, y:event.clientY, left, top, moved:false};
      launch.setPointerCapture(event.pointerId);
    });
    launch.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      launchPosition = positionLaunch(drag.left + dx, drag.top + dy);
    });
    function finishDrag(event) {
      if (drag?.id !== event.pointerId) return;
      suppressClick = drag.moved;
      drag = null;
      if (suppressClick) {
        try { localStorage.setItem(launchKey, JSON.stringify(launchPosition)); } catch (_) {}
      }
    }
    launch.addEventListener('pointerup', finishDrag);
    launch.addEventListener('pointercancel', finishDrag);
    launch.addEventListener('lostpointercapture', finishDrag);
    launch.addEventListener('click', event => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        return;
      }
      panel.hidden = !panel.hidden;
      render();
    });
    render();
  }
  function init() {checkRoute();makeUI();}
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  const observer = new MutationObserver(records => {
    if (!document.getElementById('zcp-launch')) makeUI();
    if (records.every(record => record.target.parentElement?.closest('#zcp-panel'))) return;
    if (document.querySelector(descriptionSelector) ||
        (state.character && document.querySelector('h3, [role="heading"]'))) collectVisibleDescription();
  });
  function observePage() {
    observer.observe(document.body, {childList:true, subtree:true, characterData:true,
      attributes:true, attributeFilter:['aria-hidden', 'hidden', 'class']});
    collectVisibleDescription();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observePage, {once:true});
  } else observePage();
  window.addEventListener('popstate',checkRoute);
  window.addEventListener('hashchange',checkRoute);
  setInterval(checkRoute,1200);
})();

(function () {
  'use strict';
  if (window.__zetaMobPhotosV01) return;
  window.__zetaMobPhotosV01 = true;

  const DB_NAME = 'zeta-mob-photos-v1';
  const STORE = 'mobs';
  const ROOM_REGEX = /\/rooms\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:[/?#]|$)/i;
  let roomId = null;
  let records = [];
  let imageUrls = new Map();
  let panelUI = null;
  let revision = 0;
  let scheduled = false;
  let observing = false;
  let dbPromise;
  const avatars = new Map();

  function getRoom() {
    const apiRoom = window.zetaCurrentProfiles?.get?.()?.roomId;
    const pathRoom = ROOM_REGEX.exec(location.pathname)?.[1];
    return pathRoom || apiRoom || null;
  }
  function openDb() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {keyPath:'key'});
          store.createIndex('roomId', 'roomId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function transaction(mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = callback(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const keyFor = (room, name) => JSON.stringify([room, name]);
  function cleanName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
  function clearUrls() {
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls.clear();
  }
  async function syncRoom(force = false) {
    const next = getRoom();
    if (!force && next === roomId) return;
    const generation = ++revision;
    roomId = next;
    clearAvatars();
    clearUrls();
    records = [];
    if (next) {
      try {
        const items = await transaction('readonly', s => s.index('roomId').getAll(next));
        if (revision !== generation) return;
        records = items || [];
        for (const item of records) if (item.image instanceof Blob) {
          imageUrls.set(item.key, URL.createObjectURL(item.image));
        }
      } catch (e) { console.error('[제타 모브 사진] 저장소 읽기 실패', e); }
    }
    drawUI();
    requestPaint();
  }
  async function saveMob(name, description, file) {
    if (!roomId) throw new Error('제타 채팅방을 열어주세요.');
    name = cleanName(name);
    if (!name) throw new Error('모브 이름을 입력해주세요.');
    const existing = records.find(row => row.key === keyFor(roomId, name));
    const image = file || existing?.image;
    if (!image || !photoType.test(image.type)) throw new Error('PNG, JPG, WEBP 또는 GIF 사진을 선택해주세요.');
    if (image.size > 5 * 1024 * 1024) throw new Error('사진 크기는 5MB 이하여야 합니다.');
    const item = {key:keyFor(roomId, name), roomId, name, description:String(description || '').slice(0, 3000), image, updatedAt:Date.now()};
    await transaction('readwrite', s => s.put(item));
    await syncRoom(true);
    return !!existing;
  }
  async function deleteMob(name) {
    if (!roomId) return;
    await transaction('readwrite', s => s.delete(keyFor(roomId, name)));
    await syncRoom(true);
  }
  const photoType = /^image\/(?:png|jpeg|webp|gif)$/i;

  function encodePhoto(image) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(image);
    });
  }

  async function backupMobs() {
    const items = await transaction('readonly', store => store.getAll());
    const mobs = await Promise.all(items.map(async item => ({
      roomId: item.roomId, name: item.name, description: item.description,
      type: item.image.type, photo: await encodePhoto(item.image)
    })));
    const data = new Blob([JSON.stringify({format:'zeta-profiles-mob', version:1, mobs})],
      {type:'application/json'});
    const url = URL.createObjectURL(data);
    const link = el('a');
    link.href = url;
    link.download = 'zeta-profiles-mob-backup.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return mobs.length;
  }

  async function restoreMobs(file) {
    const data = JSON.parse(await file.text());
    if (data?.format !== 'zeta-profiles-mob' || data.version !== 1 || !Array.isArray(data.mobs)) {
      throw new Error('제타 모브 백업 파일을 선택해 주세요.');
    }
    const items = new Map();
    for (const mob of data.mobs) {
      if (typeof mob?.roomId !== 'string' || !ROOM_REGEX.test('/rooms/' + mob.roomId) ||
          mob.roomId.length !== 36 || typeof mob.name !== 'string' ||
          !cleanName(mob.name) || typeof mob.type !== 'string' || !photoType.test(mob.type) ||
          typeof mob.photo !== 'string' || mob.photo.length > 6990508) {
        throw new Error('백업에 올바르지 않은 모브 정보가 있습니다.');
      }
      const bytes = Uint8Array.from(atob(mob.photo), char => char.charCodeAt(0));
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('백업 사진 크기가 올바르지 않습니다.');
      const name = cleanName(mob.name);
      const key = keyFor(mob.roomId, name);
      items.set(key, {key, roomId:mob.roomId, name, description:String(mob.description ?? '').slice(0, 3000),
        image:new Blob([bytes], {type:mob.type}), updatedAt:Date.now()});
    }
    if (!items.size || !confirm('모브 ' + items.size + '명을 복원할까요? 같은 방의 같은 이름은 백업 내용으로 덮어씁니다.')) return;
    await transaction('readwrite', store => {
      for (const item of items.values()) store.put(item);
    });
    await syncRoom(true);
    const status = document.querySelector('#zmp-backup-status');
    if (status) status.textContent = '모브 ' + items.size + '명 복원 완료';
  }

  function makeStyle() {
    if (document.getElementById('zmp-style')) return;
    const style = document.createElement('style');
    style.id = 'zmp-style';
    style.textContent = `
      #zmp-section{margin:12px 0 18px;color:var(--zcp-accent, #eee)}
      #zmp-section .zmp-mob-card header > .zcp-actions{margin-inline-start:auto;flex:none;flex-wrap:nowrap}
      #zmp-backup{gap:12px}
      #zmp-backup label{display:grid;gap:6px;min-width:0}
      #zmp-section .zmp-form[hidden]{display:none!important}
      #zmp-section .zmp-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,100px),1fr));gap:8px;margin-top:10px}
      #zmp-section h2{font-size:15px;margin:18px 0 8px;color:var(--zcp-muted, #b9bac2)}
      #zmp-section .zmp-form{display:grid;gap:7px;background:var(--zcp-form, #24242a);padding:12px;border-radius:12px;margin:8px 0}
      #zmp-section input:not([type=file]),#zmp-section textarea{box-sizing:border-box;width:100%;background:var(--zcp-input, #15151b);color:var(--zcp-text, #fff);border:1px solid var(--zcp-control-line, #777);border-radius:6px;padding:8px;font:14px system-ui}
      #zmp-section input[type=file]{width:100%;min-width:0;color:var(--zcp-file, #ddd);font:13px system-ui}
      #zmp-section input[type=file]::file-selector-button{background:var(--zcp-button, #393946);color:var(--zcp-text, #fff);border:1px solid var(--zcp-button-line, #696977);border-radius:7px;padding:8px 10px;margin-inline-end:8px;cursor:pointer}
      #zmp-section textarea{resize:vertical;min-height:52px}
      #zmp-section .zmp-mob-card{background:var(--zcp-card, #202124);padding:18px;border-radius:18px;margin:0 0 14px}
      #zmp-section header{display:flex;gap:12px;align-items:center;margin-bottom:12px}
      #zmp-section header img{width:52px;height:52px;flex:none;border-radius:50%;object-fit:cover}
      #zmp-section h3{font-size:17px;margin:0;overflow-wrap:anywhere}
      #zmp-section .zmp-mob-body{font-size:15px;line-height:1.65;color:var(--zcp-body, #e3e3e8);overflow-wrap:anywhere;white-space:pre-wrap;margin:0 0 10px}
      #zmp-section button{font-size:12px;padding:6px 8px}
      #zmp-section .zmp-hint{font-size:12px;color:var(--zcp-hint, #bcbcc5);margin:8px 0}
    `;
    document.head.appendChild(style);
  }
  function el(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value != null) node.textContent = value;
    return node;
  }
  function drawUI() {
    const output = document.querySelector('#zmp-output');
    if (!output) return;
    const existing = output.querySelector('#zmp-section');
    if (existing) existing.remove();
    const root = el('section'); root.id = 'zmp-section';
    root.append(el('h2', '', '모브 ' + records.length));
    const form = el('form', 'zmp-form');
    form.hidden = true;
    const nameInput = el('input'); nameInput.placeholder = '모브 이름 (채팅에 표시되는 발화자 이름과 동일하게)';
    nameInput.maxLength = 80; nameInput.required = true;
    const description = el('textarea'); description.placeholder = '설명 (선택)';
    const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
    let editingKey;
    const fileHint = el('small', 'zmp-hint', '새 사진을 선택하면 기존 사진이 바뀝니다.');
    fileHint.hidden = true;
    const save = el('button', '', '모브 사진 등록 / 덮어쓰기'); save.type='submit';
    const status = el('small'); status.setAttribute('role','status');
    function updateFileHint() {
      const key = keyFor(roomId, cleanName(nameInput.value));
      fileHint.hidden = !records.some(mob => mob.key === key && mob.image instanceof Blob);
    }
    nameInput.addEventListener('input', updateFileHint);
    form.append(nameInput,description,fileInput,fileHint,save,status);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try { await saveMob(nameInput.value, description.value, fileInput.files?.[0]); }
      catch (e) {status.textContent = String(e?.message || e); save.disabled = false; }
    });
    form.prepend(el('p','zmp-hint',roomId ? '현재 채팅방에만 저장됩니다. 말풍선에 발화자 이름이 별도로 표시된 경우 그 이름 옆에 사진을 붙입니다.' : '채팅방에 들어가면 모브를 등록할 수 있습니다.'));
    if (!roomId) {save.disabled = true;}
    for (const mob of records) {
      const card=el('article','zmp-mob-card');
      const img=el('img'); img.src=imageUrls.get(mob.key) || ''; img.alt='';
      const header=el('header');
      header.append(img, el('h3','',mob.name));
      card.append(header);
      if (mob.description) card.append(el('p','zmp-mob-body',mob.description));
      const edit=el('button','','수정'); edit.type='button';
      edit.addEventListener('click', () => {
        form.reset();
        editingKey = mob.key;
        nameInput.value = mob.name;
        nameInput.readOnly = true;
        description.value = mob.description || '';
        updateFileHint();
        status.textContent = '';
        save.textContent = '변경 사항 저장';
        openForm();
      });
      const del=el('button','','삭제'); del.type='button';
      del.addEventListener('click', async ()=>{if(confirm('모브 '+mob.name+'의 사진과 설명을 삭제할까요?')) await deleteMob(mob.name);});
      const actions=el('div','zcp-actions');
      actions.append(edit,del);
      header.append(actions);
      root.append(card);
    }
    const add = el('button', 'zmp-add', '모브 추가');
    add.type = 'button';
    add.disabled = !roomId;
    add.setAttribute('aria-expanded', 'false');
    form.id = 'zmp-form';
    add.setAttribute('aria-controls', form.id);

    function openForm() {
      form.hidden = false;
      add.setAttribute('aria-expanded', 'true');
      (editingKey ? description : nameInput).focus();
    }

    add.addEventListener('click', () => {
      if (!form.hidden) {
        form.hidden = true;
        add.setAttribute('aria-expanded', 'false');
        return;
      }
      form.reset();
      editingKey = undefined;
      nameInput.readOnly = false;
      updateFileHint();
      save.textContent = '모브 사진 등록 / 덮어쓰기';
      status.textContent = '';
      openForm();
    });
    const backup = el('button', '', '백업/복원');
    backup.type = 'button';
    backup.setAttribute('aria-controls', 'zmp-backup');
    backup.setAttribute('aria-expanded', 'false');
    const backupPanel = el('div', 'zmp-form');
    backupPanel.id = 'zmp-backup';
    backupPanel.hidden = true;
    const download = el('button', '', '전체 채팅방 백업 다운로드');
    download.type = 'button';
    const restoreLabel = el('label', '', '백업 파일로 복원');
    const restore = el('input');
    restore.type = 'file';
    restore.accept = '.json,application/json';
    restoreLabel.append(restore);
    const backupStatus = el('p', 'zmp-hint');
    backupStatus.id = 'zmp-backup-status';
    backupStatus.setAttribute('role', 'status');
    backupPanel.append(download, restoreLabel);
    backup.addEventListener('click', () => {
      backupPanel.hidden = !backupPanel.hidden;
      backup.setAttribute('aria-expanded', String(!backupPanel.hidden));
    });
    async function runBackup(action) {
      download.disabled = restore.disabled = true;
      backupStatus.textContent = '';
      try { await action(); }
      catch (error) { backupStatus.textContent = '처리 실패. ' + (error.message || error); }
      finally { download.disabled = restore.disabled = false; }
    }
    download.addEventListener('click', () => runBackup(async () => {
      backupStatus.textContent = '모브 ' + await backupMobs() + '명 백업 파일 생성';
    }));
    restore.addEventListener('change', () => {
      const file = restore.files[0];
      restore.value = '';
      if (file) runBackup(() => restoreMobs(file));
    });
    const actions = el('div', 'zmp-actions');
    actions.append(add, backup);
    root.append(form, backupPanel, backupStatus, actions);
    output.append(root);
    panelUI = root;
  }
  const avatarSelector = '[data-sentry-component="LeftTextContent"] > img[alt]';

  function restoreAvatar(host, entry) {
    if (host.getAttribute('src') === entry.src) {
      if (entry.originalSrc === null) host.removeAttribute('src');
      else host.setAttribute('src', entry.originalSrc);
    }
    if (!host.hasAttribute('srcset') && entry.originalSrcset !== null) {
      host.setAttribute('srcset', entry.originalSrcset);
    }
    avatars.delete(host);
  }

  function clearAvatars() {
    for (const [host, entry] of avatars) restoreAvatar(host, entry);
  }

  function paintChat() {
    const names = new Map(records.map(row => [row.name, imageUrls.get(row.key)]));
    const seen = new Set();
    if (roomId && names.size) {
      for (const host of document.querySelectorAll(avatarSelector)) {
        const src = names.get(cleanName(host.alt));
        if (!src) continue;
        seen.add(host);
        const entry = avatars.get(host);
        if (entry?.src === src && host.getAttribute('src') === src &&
            !host.hasAttribute('srcset')) continue;
        if (entry) restoreAvatar(host, entry);
        avatars.set(host, {
          src,
          originalSrc: host.getAttribute('src'),
          originalSrcset: host.getAttribute('srcset')
        });
        host.removeAttribute('srcset');
        host.setAttribute('src', src);
      }
    }
    for (const [host, entry] of avatars) {
      if (!seen.has(host)) restoreAvatar(host, entry);
    }
  }
  function requestPaint() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(()=>{scheduled=false;try {paintChat();} catch(e) {console.error('[제타 모브 사진]',e);} },200);
  }
  function observe() {
    if (observing || !document.body) return;
    observing=true;
    const observer=new MutationObserver(changes=>{
      if (changes.every(c => c.target.closest?.('#zmp-section'))) return;
      if (document.querySelector('#zmp-output') && !document.querySelector('#zmp-section')) drawUI();
      requestPaint();
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['alt','src','srcset']});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) syncRoom();});
    window.addEventListener('zeta-current-profiles-updated',()=>syncRoom());
    window.addEventListener('popstate',()=>syncRoom());
    window.addEventListener('hashchange',()=>syncRoom());
    window.addEventListener('resize',requestPaint);
    setInterval(()=>syncRoom(),1200);
  }
  function init() {makeStyle();syncRoom(true);observe();}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
