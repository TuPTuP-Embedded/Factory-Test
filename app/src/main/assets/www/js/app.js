// TP-01 极简版（键盘 / 灯光 + 固件升级）—— 连接、88 键、音符/灯光/检验、固件升级、日志
import { encodePackets, BLEMidiDecoder, MIDI_SERVICE_UUID, MIDI_CHAR_UUID } from './midi-codec.js';
import {
  noteName, LIGHT_COLOR_OPTIONS, lightOn, lightOff, allLightsOff,
  noteOn, noteOff, allNotesOff, describeMessage, bytesToHex,
} from './tp01.js';
import {
  analyzeBle, packBin, parseReply, describeFwReply, UpgradeSession, FW_ERROR_TEXT,
  hasBinHeader, hasBinMarker, inspectBin, addBinHeader, firmwareWarning,
  detectBinaryPrefix, guessBinaryPrefix, makeBinName,
} from './firmware.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  device: null, server: null, service: null, char: null, connected: false, writer: null,
  decoder: null,
  transport: null,
  usbAccess: null, usbOutput: null, usbInputs: null,
  keyMode: 'note', keyChannel: 1, keyVelocity: 100, lightColor: 1,
  pointerNote: null,
  checkReceived: new Set(),
  fsByUs: false,
  lightAllRunning: false,
  rxCount: 0, txCount: 0, logStart: performance.now(),
  upgrading: false,
  fw: {
    image: null, problem: '', fileName: '', source: '', sourceName: '', packed: null,
    binOriginal: null, binProg: null, binHasHeader: false, binVersion: null, prefix: 'APP_', binWarn: '',
    block: 512, packetSize: 0, gap: 0, withResponse: false, verbose: false,
    session: null, canceled: false, wakeLock: null,
  },
};

const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (n) => BLACK.has(n % 12);
const KEY_START = 21;   // A0
const KEY_END = 108;    // C8
const KEY_TOTAL = KEY_END - KEY_START + 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function nowTag() {
  const ms = performance.now() - state.logStart;
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function setStatus(text, cls) {
  $('#statusText').textContent = text;
  $('#statusDot').className = `dot ${cls}`;
}

// ─────────────────── 日志 ───────────────────
function updateStats() {
  $('#logStats').textContent = `收 ${state.rxCount} / 发 ${state.txCount}`;
}

function addLog(dir, hex, desc, cls) {
  if (dir === 'RX') state.rxCount++;
  else if (dir === 'TX') state.txCount++;
  updateStats();
  const body = $('#logBody');
  if (!body) return;
  const line = document.createElement('div');
  line.className = `logline ${cls || (dir === 'RX' ? 'rx' : dir === 'TX' ? 'tx' : 'sys')}`;
  line.innerHTML = `<span class="lt">${nowTag()}</span><span class="ld">${dir}</span><span class="lh">${hex}</span><span class="lx">${escapeHtml(desc)}</span>`;
  body.appendChild(line);
  while (body.childElementCount > 1000) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

// ─────────────────── 连接 ───────────────────
async function connectDevice() {
  if ($('#connType').value === 'usb') return connectUsb();
  return connectBle();
}

function updateConnTypeUi() {
  const usb = $('#connType').value === 'usb';
  const bar = $('#showAllDevices') && $('#showAllDevices').closest('label');
  if (bar) bar.style.display = usb ? 'none' : '';
  if (state.connected && state.transport !== (usb ? 'usb' : 'ble')) {
    toast('已切换连接方式，请先断开再重新连接', 2600);
  }
  refreshFwHint();
}

async function connectBle() {
  if (!navigator.bluetooth) {
    toast('当前浏览器不支持 Web Bluetooth（请用 Android Chrome / Edge）', 4000);
    return;
  }
  const opts = $('#showAllDevices').checked
    ? { acceptAllDevices: true, optionalServices: [MIDI_SERVICE_UUID] }
    : { filters: [{ services: [MIDI_SERVICE_UUID] }], optionalServices: [MIDI_SERVICE_UUID] };
  try {
    const device = await navigator.bluetooth.requestDevice(opts);
    await connectTo(device);
  } catch (e) {
    if (e.name !== 'NotFoundError') toast('选择设备失败：' + e.message);
  }
}

async function connectTo(device) {
  disconnect(true);
  state.device = device;
  device.addEventListener('gattserverdisconnected', onDisconnected);
  setStatus('连接中…', 'wait');
  try {
    const server = await device.gatt.connect();
    state.server = server;
    const service = await server.getPrimaryService(MIDI_SERVICE_UUID);
    state.service = service;
    const char = await service.getCharacteristic(MIDI_CHAR_UUID);
    await attachBleChar(char);

    state.connected = true;
    state.transport = 'ble';
    setStatus(`已连接 ${device.name || ''}`, 'on');
    $('#btnConnect').hidden = true;
    $('#btnDisconnect').hidden = false;
    addLog('··', '', `已连接 ${device.name || ''}`, 'sys');
    refreshFwHint();
  } catch (e) {
    setStatus('连接失败', 'off');
    toast('连接失败：' + e.message, 3500);
    disconnect(true);
  }
}

// 绑定 BLE MIDI 特征值（首次连接与升级中断线重连共用）
async function attachBleChar(char) {
  state.char = char;
  state.writer = char.properties.writeWithoutResponse ? 'wo' : 'w';
  state.decoder = new BLEMidiDecoder(({ message }) => {
    addLog('RX', bytesToHex(message), describeRx(message));
    handleIncoming(message);
  });
  await char.startNotifications();
  char.addEventListener('characteristicvaluechanged', onNotify);
}

function describeRx(message) {
  const r = parseReply(message);
  return r ? `升级应答 · ${describeFwReply(r)}` : describeMessage(message);
}

function onNotify(event) {
  const dv = event.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  try { state.decoder.push(bytes); } catch {}
}

function onDisconnected() {
  addLog('··', '', '连接已断开', 'sys');
  if (state.upgrading) {
    // 升级中：保留 device 用于自动重连
    if (state.char) { try { state.char.removeEventListener('characteristicvaluechanged', onNotify); } catch {} }
    state.char = null;
    state.server = null;
    state.service = null;
    state.connected = false;
    setStatus('蓝牙断开，正在重连…', 'wait');
    if (state.fw.session) state.fw.session.interrupt('disconnected');
    return;
  }
  disconnect(true);
}

function disconnect(silent) {
  if (state.upgrading) abortFw('连接已断开');
  if (state.char) {
    try { state.char.removeEventListener('characteristicvaluechanged', onNotify); } catch {}
    try { state.char.stopNotifications(); } catch {}
  }
  if (state.device) {
    try { state.device.removeEventListener('gattserverdisconnected', onDisconnected); } catch {}
  }
  try { if (state.server && state.server.connected) state.server.disconnect(); } catch {}
  if (state.usbInputs) state.usbInputs.forEach((i) => { try { i.onmidimessage = null; } catch {} });
  if (state.usbAccess) { try { state.usbAccess.onstatechange = null; } catch {} }
  state.device = state.server = state.service = state.char = null;
  state.usbAccess = state.usbOutput = state.usbInputs = null;
  state.transport = null;
  state.connected = false;
  if (!silent) addLog('··', '', '已断开', 'sys');
  setStatus('未连接', 'off');
  $('#btnConnect').hidden = false;
  $('#btnDisconnect').hidden = true;
  refreshFwHint();
}

// ─────────────────── USB MIDI ───────────────────
async function connectUsb() {
  if (!navigator.requestMIDIAccess) {
    toast('当前浏览器不支持 Web MIDI（请用 Android Chrome / Edge）', 4000);
    return;
  }
  disconnect(true);
  setStatus('请求 USB MIDI 权限…', 'wait');
  try {
    const access = await navigator.requestMIDIAccess();
    state.usbAccess = access;

    const outputs = [...access.outputs.values()];
    if (!outputs.length) {
      setStatus('未连接', 'off');
      toast('没有找到 USB MIDI 设备：请检查 OTG 转接线、设备是否插好', 4000);
      return;
    }

    let output;
    if (outputs.length === 1) {
      output = outputs[0];
    } else {
      const tp = outputs.find((o) => /TP-?01/i.test(o.name || ''));
      output = tp || (await pickUsbOutput(outputs));
    }
    if (!output) { setStatus('未连接', 'off'); return; }

    const inputs = [...access.inputs.values()];
    const sameName = inputs.filter((i) => i.name === output.name);
    const useInputs = sameName.length ? sameName : inputs;
    useInputs.forEach((input) => { input.onmidimessage = onUsbMidiMessage; });

    state.transport = 'usb';
    state.usbOutput = output;
    state.usbInputs = useInputs;
    state.connected = true;

    access.onstatechange = (e) => {
      const port = e.port;
      if (state.transport === 'usb' && port.type === 'output' && port.id === output.id && port.state === 'disconnected') {
        addLog('··', '', 'USB MIDI 设备已断开', 'sys');
        disconnect(true);
      }
    };

    setStatus(`已连接 USB ${output.name || ''}`, 'on');
    $('#btnConnect').hidden = true;
    $('#btnDisconnect').hidden = false;
    addLog('··', '', `USB MIDI 已连接：${output.name || '(未命名)'}${useInputs.length ? '' : '（无输入端口，只能发送）'}`, 'sys');
    refreshFwHint();
  } catch (e) {
    setStatus('未连接', 'off');
    toast('USB MIDI 连接失败：' + (e.message || e.name), 3600);
  }
}

function pickUsbOutput(outputs) {
  return new Promise((resolve) => {
    const overlay = $('#usbPick');
    const list = $('#usbPickList');
    const cancel = $('#usbPickCancel');
    list.innerHTML = '';
    outputs.forEach((o) => {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = `${o.name || '(未命名)'}${o.manufacturer ? ' · ' + o.manufacturer : ''}`;
      b.addEventListener('click', () => { overlay.hidden = true; resolve(o); });
      list.appendChild(b);
    });
    cancel.onclick = () => { overlay.hidden = true; resolve(null); };
    overlay.hidden = false;
  });
}

function onUsbMidiMessage(e) {
  const data = e.data;
  addLog('RX', bytesToHex(data), describeRx(data));
  handleIncoming(data);
}

// ─────────────────── 发送 ───────────────────
function doWrite(bytes) {
  if (!state.char) return Promise.reject(new Error('未连接'));
  return state.writer === 'wo'
    ? state.char.writeValueWithoutResponse(bytes)
    : state.char.writeValue(bytes);
}

let writeChain = Promise.resolve();
function writeChar(bytes) {
  writeChain = writeChain.then(() => doWrite(bytes)).catch((e) => toast('发送失败：' + e.message));
  return writeChain;
}

async function sendMidi(midiBytes, { silent = false } = {}) {
  if (state.upgrading) { toast('固件升级进行中，已暂停其它发送'); return false; }
  if (!state.connected) { toast('请先连接设备'); return false; }
  const arr = midiBytes instanceof Uint8Array ? Array.from(midiBytes) : midiBytes;
  if (!silent) addLog('TX', bytesToHex(arr), describeMessage(arr));

  if (state.transport === 'usb') {
    try {
      state.usbOutput.send(Uint8Array.from(arr));
    } catch (e) {
      toast('USB MIDI 发送失败：' + e.message);
      return false;
    }
    return true;
  }

  const packets = encodePackets(arr, Math.floor(performance.now()) & 0x1fff);
  for (const p of packets) await writeChar(p);
  return true;
}

// ─────────────────── 键盘 ───────────────────
function renderKeyboard() {
  const wrap = $('#keyboard');
  wrap.innerHTML = '';
  const whites = [];
  for (let n = KEY_START; n <= KEY_END; n++) if (!isBlack(n)) whites.push(n);
  const w = 100 / whites.length;
  const blackW = w * 0.62;

  for (let n = KEY_START; n <= KEY_END; n++) {
    if (isBlack(n)) continue;
    const i = whites.indexOf(n);
    const k = document.createElement('div');
    k.className = 'key white';
    k.dataset.note = n;
    k.style.left = `${i * w}%`;
    k.style.width = `${w}%`;
    if (n % 12 === 0) k.innerHTML = `<span>${noteName(n)}</span>`;
    wrap.appendChild(k);
  }
  for (let n = KEY_START; n <= KEY_END; n++) {
    if (!isBlack(n)) continue;
    let lower = n - 1;
    while (isBlack(lower)) lower--;
    const i = whites.indexOf(lower);
    const k = document.createElement('div');
    k.className = 'key black';
    k.dataset.note = n;
    k.style.left = `${(i + 1) * w - blackW / 2}%`;
    k.style.width = `${blackW}%`;
    wrap.appendChild(k);
  }
}

function litKey(note, on) {
  if (note < KEY_START || note > KEY_END) return;
  const k = document.querySelector(`#keyboard .key[data-note="${note}"]`);
  if (k) k.classList.toggle('rx', on);
}
function clearLit() {
  $$('#keyboard .key.rx').forEach((k) => k.classList.remove('rx'));
}

function keyDown(note) {
  if (state.keyMode === 'check') return;
  if (state.pointerNote !== null) return;
  state.pointerNote = note;
  if (state.keyMode === 'light') sendMidi(lightOn(note, state.lightColor));
  else sendMidi(noteOn(note, state.keyVelocity, state.keyChannel));
}
function keyUp(note) {
  if (state.pointerNote !== note) return;
  state.pointerNote = null;
  if (state.keyMode === 'light') sendMidi(lightOff(note, 0));
  else sendMidi(noteOff(note, state.keyChannel));
}

// ─────────────────── 检验 ───────────────────
function updateCheckProgress() {
  $('#checkProgress').textContent = `已收到 ${state.checkReceived.size} / ${KEY_TOTAL}`;
}
function resetCheck() {
  state.checkReceived.clear();
  hidePass();
  $$('#keyboard .key').forEach((k) => k.classList.remove('received'));
  updateCheckProgress();
}
function markReceived(note) {
  if (note < KEY_START || note > KEY_END) return;
  if (state.checkReceived.has(note)) return;
  state.checkReceived.add(note);
  const k = document.querySelector(`#keyboard .key[data-note="${note}"]`);
  if (k) k.classList.add('received');
  updateCheckProgress();
  if (state.checkReceived.size >= KEY_TOTAL) showPass();
}
function showPass() {
  const el = $('#passOverlay');
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 5000);
}
function hidePass() {
  const el = $('#passOverlay');
  clearTimeout(el._t);
  el.classList.remove('show');
}

// ─────────────────── 自动横屏 ───────────────────
const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  Promise.resolve(p).then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); }
  );
});

async function enterLandscape() {
  if (!isTouchDevice()) return;
  let locked = false;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await withTimeout(document.documentElement.requestFullscreen({ navigationUI: 'hide' }), 1500).catch(() => {});
      state.fsByUs = !!document.fullscreenElement;
    }
    if (screen.orientation && screen.orientation.lock) {
      await withTimeout(screen.orientation.lock('landscape'), 1500);
      locked = true;
    }
  } catch { locked = false; }
  if (!locked) {
    try { if (state.fsByUs && document.fullscreenElement) await document.exitFullscreen(); } catch {}
    state.fsByUs = false;
    toast('无法自动横屏，请手动旋转手机', 2600);
  }
}

async function exitLandscape() {
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch {}
  try { if (state.fsByUs && document.fullscreenElement) await document.exitFullscreen(); } catch {}
  state.fsByUs = false;
}

function applyKeyMode() {
  const kb = $('#keyboard');
  kb.classList.toggle('check', state.keyMode === 'check');
  $$('.light-opts').forEach((el) => (el.style.display = state.keyMode === 'light' ? '' : 'none'));
  $$('.note-opts').forEach((el) => (el.style.display = state.keyMode === 'note' ? '' : 'none'));
  $$('.check-opts').forEach((el) => (el.style.display = state.keyMode === 'check' ? '' : 'none'));
  clearLit();
  if (state.keyMode === 'check') resetCheck();
}

// ─────────────────── 收到设备消息 ───────────────────
function handleIncoming(bytes) {
  // 固件升级应答
  if (state.fw.session && state.fw.session.feedReply(bytes)) return;

  const status = bytes[0];
  const type = status & 0xf0;
  const note = bytes[1];
  const isOn = type === 0x90 && bytes[2] > 0;
  const isOff = type === 0x80 || (type === 0x90 && bytes[2] === 0);

  if (state.keyMode === 'check') {
    if (type === 0x80 || type === 0x90) markReceived(note);
    return;
  }
  if (state.keyMode === 'note' || state.keyMode === 'light') {
    const isLightOn = status === 0xa1;
    const isLightOff = status === 0xa0;
    if (isOn || isLightOn) litKey(note, true);
    else if (isLightOff && note === 0) clearLit();      // A0 00 00 全部熄灭
    else if (isOff || isLightOff) litKey(note, false);
  }
}

// ─────────────────── 全部亮某色 ───────────────────
async function lightAllKeys(color, label, btn) {
  if (!state.connected) { toast('请先连接设备'); return; }
  if (state.lightAllRunning) return;
  state.lightAllRunning = true;
  const btns = $$('.light-all');
  const prev = btn ? btn.textContent : '';
  btns.forEach((b) => (b.disabled = true));
  if (btn) btn.textContent = '发送中…';
  try {
    addLog('TX', `×${KEY_TOTAL}`, `全部亮${label}（逐灯 21–108，间隔 20ms）`, 'sys');
    for (let n = KEY_START; n <= KEY_END; n++) {
      await sendMidi(lightOn(n, color), { silent: true });
      if (n < KEY_END) await sleep(20);
    }
    toast(`全部亮${label} 完成`);
  } finally {
    state.lightAllRunning = false;
    btns.forEach((b) => (b.disabled = false));
    if (btn) btn.textContent = prev;
  }
}

let upgradeWriteChain = Promise.resolve();

function writeUpgrade(bytes, withResponse = false) {
  const p = upgradeWriteChain.then(() => {
    if (!state.char) throw new Error('未连接');
    if (withResponse && typeof state.char.writeValue === 'function') return state.char.writeValue(bytes);
    return state.writer === 'wo'
      ? state.char.writeValueWithoutResponse(bytes)
      : state.char.writeValue(bytes);
  });
  upgradeWriteChain = p.then(() => {}, () => {});
  return p;
}

function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setFwStatus(text) {
  $('#fwStatus').textContent = text;
}

function setFwButtons() {
  const fw = state.fw;
  const running = state.upgrading;
  const canStart = !!fw.image && !running && state.connected && state.transport === 'ble';
  $('#btnFwStart').disabled = !canStart;
  $('#btnFwStop').disabled = !running;
  $('#fwFile').disabled = running;
  $('#fwBlock').disabled = running;
  $('#fwTarget').disabled = running;
  $('#fwVersion').disabled = running || fw.binHasHeader;
  $('#btnFwDownload').disabled = running || !fw.packed;
  $('#btnFwStart').title = !fw.image ? '请先选择升级文件'
    : !state.connected ? '请先连接 TP-01（蓝牙）'
      : state.transport !== 'ble' ? '固件升级仅支持蓝牙 BLE 连接'
        : '开始升级';
}

function refreshFwHint() {
  if (state.upgrading) return;
  const fw = state.fw;
  if (!fw.image) {
    setFwStatus(fw.problem ? '文件自检失败' : '未选择升级文件');
  } else if (!state.connected) {
    setFwStatus('请先连接 TP-01（蓝牙）');
  } else if (state.transport !== 'ble') {
    setFwStatus('固件升级仅支持蓝牙 BLE 连接');
  } else {
    setFwStatus('文件自检通过，可以开始升级');
  }
  setFwButtons();
}

function resetFwProgress(N) {
  $('#fwBar').style.width = '0%';
  $('#fwBar').parentElement.classList.remove('done', 'fail');
  $('#fwStats').textContent = N ? `${Math.max(N - 1, 0)} 帧待发送` : '';
}

function renderFwInfo() {
  const fw = state.fw;
  const box = $('#fwInfo');

  if (!fw.sourceName) {
    $('#fwFileName').textContent = '未选择文件';
  } else if (fw.source === 'bin') {
    $('#fwFileName').textContent = fw.image
      ? `${fw.sourceName} → ${fw.image.filename}（升级包 ${fmtSize(fw.image.bytes.length)}）`
      : fw.sourceName;
  } else {
    $('#fwFileName').textContent = fw.image
      ? `${fw.sourceName}（${fmtSize(fw.image.bytes.length)}）`
      : fw.sourceName;
  }

  if (!fw.image) {
    box.innerHTML = fw.problem
      ? `<span class="bad">✗ ${escapeHtml(fw.problem)}</span>`
      : '未选择升级文件';
    setFwButtons();
    return;
  }

  const img = fw.image;
  const rows = [];
  if (fw.source === 'bin') {
    rows.push(['源文件', `${escapeHtml(fw.sourceName)}${fw.binHasHeader ? '（带 16 字节头）' : '（原始程序，已自动加头）'}`]);
  }
  rows.push(
    ['对象', `${img.target} <span class="k">(${escapeHtml(img.filename)})</span>`],
    ['版本', img.version == null ? '<span class="warn">未知</span>' : `<b>${img.version}</b>`],
    ['数据', `${fmtSize(img.fileLen)} · 块 ${img.block} 字节`],
    ['帧', `${img.N} 帧 × ${img.L} 字节`],
    ['CRC32', `<span class="mono">${img.crc32.toString(16).toUpperCase().padStart(8, '0')}</span>`],
    ['自检', '<span class="ok">✓ 通过（帧头 / CRC16 / 帧号 / 整体 CRC32）</span>'],
  );
  if (img.warn) rows.push(['提示', `<span class="warn">${escapeHtml(img.warn)}</span>`]);
  box.innerHTML = rows.map(([k, v]) => `<div><span class="k">${k}</span> ${v}</div>`).join('');
  setFwButtons();
}

const FW_LAST_VER_KEY = 'tp01.fw.lastVersions';
function lastFwVersion(prefix) {
  try {
    const map = JSON.parse(localStorage.getItem(FW_LAST_VER_KEY)) || {};
    return map[prefix] || null;
  } catch { return null; }
}
function saveFwVersion(prefix, version) {
  try {
    const map = JSON.parse(localStorage.getItem(FW_LAST_VER_KEY)) || {};
    map[prefix] = version;
    localStorage.setItem(FW_LAST_VER_KEY, JSON.stringify(map));
  } catch {}
}

function updateFwBinName() {
  const fw = state.fw;
  if (fw.source !== 'bin') return;
  const prefix = $('#fwTarget').value;
  const v = Number($('#fwVersion').value);
  $('#fwBinName').value = v > 0 ? makeBinName(prefix, v) : '';

  const msgs = [];
  if (fw.binHasHeader) {
    const detected = detectBinaryPrefix(fw.sourceName);
    if (detected && detected !== prefix) {
      msgs.push(`<span class="warn">注意：原文件名是 ${detected}，改成 ${prefix} 会改变琴上的安装位置，请确认</span>`);
    } else if (!detected) {
      msgs.push('<span class="warn">无法从原文件名判断升级对象，请确认选择正确</span>');
    }
  } else {
    msgs.push('<span class="k">原始程序没有 16 字节头：将按 iap_pack.py 规则加头（长度 + 累加和 + 版本号 + FF FF 00 00）</span>');
    if (fw.binWarn) msgs.unshift(`<span class="warn">${escapeHtml(fw.binWarn)}</span>`);
  }
  $('#fwBinWarn').innerHTML = msgs.join('<br>');
}

function analyzeBleFile(name, bytes) {
  const fw = state.fw;
  fw.source = 'ble';
  fw.sourceName = name;
  fw.fileName = name;
  fw.packed = null;
  fw.binOriginal = fw.binProg = null;
  fw.binHasHeader = false;
  fw.binVersion = null;
  fw.binWarn = '';
  $('#fwBinBox').hidden = true;

  const image = analyzeBle(bytes);
  fw.image = image.ok ? image : null;
  fw.problem = image.ok ? '' : image.problem;
  resetFwProgress(image.ok ? image.N : null);
  renderFwInfo();
  setFwButtons();
  refreshFwHint();
}

function loadBinFile(name, bytes) {
  const fw = state.fw;
  fw.source = 'bin';
  fw.sourceName = name;
  fw.fileName = name;
  fw.packed = null;
  fw.image = null;
  fw.problem = '';
  fw.binOriginal = bytes;
  fw.binHasHeader = hasBinHeader(bytes);
  fw.binProg = fw.binHasHeader ? bytes.subarray(16) : bytes;
  fw.binWarn = fw.binHasHeader ? '' : firmwareWarning(bytes);
  fw.binVersion = null;
  fw.prefix = detectBinaryPrefix(name) || guessBinaryPrefix(name);

  if (!fw.binHasHeader && hasBinMarker(bytes)) {
    fw.problem = '文件里有 16 字节头的标记，但长度字段对不上：文件可能损坏（不要当成原始程序加头）';
  }

  if (fw.binHasHeader) {
    try {
      fw.binVersion = inspectBin(bytes).version;
    } catch (e) {
      fw.problem = e.message;
    }
  }

  $('#fwBinBox').hidden = false;
  $('#fwTarget').value = fw.prefix;
  const verInput = $('#fwVersion');
  verInput.disabled = fw.binHasHeader;
  verInput.value = fw.binHasHeader
    ? String(fw.binVersion ?? '')
    : String(lastFwVersion(fw.prefix) ?? '');
  updateFwBinName();
  packFwBin();
}

function packFwBin() {
  const fw = state.fw;
  if (fw.source !== 'bin') return;

  fw.prefix = $('#fwTarget').value;
  const rawVersion = Number($('#fwVersion').value);
  if (!fw.binHasHeader) fw.binVersion = Number.isInteger(rawVersion) ? rawVersion : null;
  updateFwBinName();

  const fail = (msg) => {
    fw.packed = null;
    fw.image = null;
    fw.problem = msg;
    resetFwProgress(null);
    renderFwInfo();
    setFwButtons();
    refreshFwHint();
  };

  if (!fw.binProg || !fw.binProg.length) return fail('程序文件是空的');
  if (fw.binHasHeader && fw.problem) return fail(fw.problem);
  if (!fw.binHasHeader && hasBinMarker(fw.binProg)) {
    return fail('文件里有 16 字节头标记但长度对不上：文件可能损坏（不要当原始程序加头）');
  }

  const version = fw.binHasHeader ? fw.binVersion : rawVersion;
  if (!fw.binHasHeader && !(Number.isInteger(rawVersion) && rawVersion > 0)) {
    return fail('请填写版本号（1～999 的整数，必须大于琴里现有版本）');
  }
  if (fw.binHasHeader && !version) return fail('文件头里的版本号无效');
  if (version > 999) return fail('版本号太大：8.3 文件名最多 8 个字符（版本最多 3 位）');

  const name = $('#fwBinName').value;
  try {
    const binBytes = fw.binHasHeader ? fw.binOriginal : addBinHeader(fw.binProg, version);
    const packed = packBin(name, binBytes, fw.block);
    const image = analyzeBle(packed.bytes);
    if (!image.ok) throw new Error(image.problem);

    fw.packed = packed;
    fw.fileName = name;
    fw.image = image;
    fw.problem = '';
    saveFwVersion(fw.prefix, version);
    addLog('··', '', `已打包 ${fw.sourceName} → ${name}（${image.N} 帧 × ${image.L} 字节，块 ${packed.block}）`, 'sys');
    resetFwProgress(image.N);
    renderFwInfo();
    setFwButtons();
    refreshFwHint();
  } catch (e) {
    fail(e.message);
  }
}

async function onFwFile(file) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.fw.block = Number($('#fwBlock').value) || 512;
    if (/\.bin$/i.test(file.name)) loadBinFile(file.name, bytes);
    else analyzeBleFile(file.name, bytes);
  } catch (e) {
    toast('读取文件失败：' + e.message, 3500);
  }
}

function downloadFw() {
  const packed = state.fw.packed;
  if (!packed) return;
  const blob = new Blob([packed.bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = packed.filename.replace(/\.BIN$/i, '') + '.ble';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已生成 ' + a.download, 2600);
}

function askFwConfirm() {
  const fw = state.fw;
  if (!fw.image) return toast('请先选择升级文件');
  if (!state.connected) return toast('请先连接 TP-01（蓝牙）');
  if (state.transport !== 'ble') return toast('固件升级仅支持蓝牙 BLE 连接', 3500);
  const img = fw.image;
  const rows = [
    ['文件', `${escapeHtml(img.filename)}（${fmtSize(img.fileLen)}）`],
    ['对象', img.target],
    ['版本', img.version == null ? '未知' : String(img.version)],
    ['帧数', `${img.N} 帧 × ${img.L} 字节`],
    ['包长', state.fw.packetSize ? `${state.fw.packetSize} 字节` : '20 字节（与 PC 工具一致）'],
  ];
  $('#fwConfirmInfo').innerHTML = rows.map(([k, v]) => `<div><span class="k">${k}</span>${v}</div>`).join('');
  $('#fwConfirm').hidden = false;
}

async function startFw() {
  if (state.upgrading) return;
  if (!state.fw.image) return toast('请先选择升级文件');
  if (!state.connected) return toast('请先连接 TP-01（蓝牙）');
  if (state.transport !== 'ble') return toast('固件升级仅支持蓝牙 BLE 连接', 3500);

  const fw = state.fw;
  const img = fw.image;
  state.upgrading = true;
  fw.canceled = false;
  setFwStatus('正在连接琴…');
  $('#fwBar').style.width = '0%';
  $('#fwBar').parentElement.classList.remove('done', 'fail');
  $('#fwStats').textContent = `${Math.max(img.N - 1, 0)} 帧待发送`;
  setFwButtons();
  await acquireWakeLock();

  addLog('··', '', `开始固件升级：${img.filename}（${img.N} 帧 × ${img.L} 字节）`, 'sys');

  try {
    for (;;) {
      if (fw.canceled) break;
      const session = new UpgradeSession({ image: img, sendFrame: sendUpgradeFrame, onEvent: onFwEvent });
      fw.session = session;
      const res = await session.run();
      fw.session = null;
      if (fw.canceled) break;

      if (res.ok) {
        setFwStatus('升级成功，琴正在重启安装，请勿关机');
        $('#fwBar').style.width = '100%';
        $('#fwBar').parentElement.classList.add('done');
        addLog('··', '', `升级成功：${img.filename}（共发 ${res.sent} 帧，重发 ${res.resent} 次）`, 'sys');
        toast('升级成功，琴正在重启安装，请勿关机', 5000);
        break;
      }

      if (res.interrupted === 'disconnected') {
        setFwStatus('蓝牙断开，正在重连…');
        const reconnected = await tryReconnect(60000);
        if (!reconnected) { fwFail('重连失败，升级中止'); break; }
        addLog('··', '', '已重连，从第 0 帧继续（琴会回复断点帧号）', 'sys');
        setFwStatus('已重连，继续升级…');
        continue;
      }

      if (res.interrupted === 'send') { fwFail(res.error || '发送失败', res.k); break; }
      if (res.canceled) { setFwStatus('已停止'); addLog('··', '', '升级已停止', 'sys'); break; }
      fwFail(res.error || '升级失败', res.k);
      break;
    }
  } catch (e) {
    fwFail(e.message || String(e));
  } finally {
    fw.session = null;
    state.upgrading = false;
    setFwButtons();
    await releaseWakeLock();
  }
}

async function sendUpgradeFrame(k, frameBytes) {
  // 默认 20 字节：与 PC 工具（Windows 下 bleak 的 MTU 23）一致，兼容性最好
  const size = state.fw.packetSize || 20;
  const gap = state.fw.gap;
  const packets = encodePackets(frameBytes, Math.floor(performance.now()) & 0x1fff, size);
  try {
    for (let i = 0; i < packets.length; i++) {
      await writeUpgrade(packets[i], state.fw.withResponse);
      if (gap && i < packets.length - 1) await sleep(gap);
    }
  } catch (e) {
    if (state.fw.packetSize > 20) {
      throw new Error(`${e.message || '写入失败'}（包长 ${state.fw.packetSize} 可能超出蓝牙模块支持，请改回"自动"）`);
    }
    throw e;
  }
}

function onFwEvent(type, a, b, c) {
  const fw = state.fw;
  if (type === 'status') {
    setFwStatus(a);
  } else if (type === 'progress') {
    const done = a;
    const total = b;
    $('#fwBar').style.width = `${(total > 0 ? Math.min(done / total, 1) : 0) * 100}%`;
    $('#fwStats').textContent = c ? `${done} / ${total} 帧 · ${c}` : `${done} / ${total} 帧`;
  } else if (type === 'log') {
    if (fw.verbose || /开始升级|完成|断点|稍等|失败/.test(a)) addLog('··', '', a, 'sys');
  } else if (type === 'reply') {
    if (fw.verbose) addLog('··', '', `← ${describeFwReply(a)}`, 'sys');
  }
}

function fwFail(msg, k) {
  let text = /^升级失败/.test(msg) ? msg : `升级失败：${msg}`;
  if (k != null && !/第 \d+ 帧/.test(text)) text += `（停在发第 ${k} 帧）`;
  if (/0x13|写入失败/.test(msg)) {
    text += state.fw.withResponse
      ? ' · 已开启写入确认，仍失败请给琴断电重启后再试'
      : ' · 可调大包间隔或勾选"写入带确认"后重试';
  }
  setFwStatus(text);
  $('#fwBar').parentElement.classList.add('fail');
  addLog('··', '', text, 'sys');
  toast(text, 6000);
}

function abortFw(reason) {
  const fw = state.fw;
  if (!state.upgrading && !fw.session) return;
  fw.canceled = true;
  if (fw.session) fw.session.cancel();
  addLog('··', '', `固件升级中止：${reason}`, 'sys');
  setFwStatus(reason);
}

async function tryReconnect(timeoutMs) {
  const dev = state.device;
  if (!dev) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.fw.canceled) return false;
    try {
      const server = await dev.gatt.connect();
      state.server = server;
      const service = await server.getPrimaryService(MIDI_SERVICE_UUID);
      state.service = service;
      const char = await service.getCharacteristic(MIDI_CHAR_UUID);
      await attachBleChar(char);
      state.connected = true;
      setStatus(`已重连 ${dev.name || ''}`, 'on');
      setFwButtons();
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    state.fw.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    state.fw.wakeLock = null;
  }
}

async function releaseWakeLock() {
  try { await state.fw.wakeLock?.release(); } catch {}
  state.fw.wakeLock = null;
}

function initFwEvents() {
  $('#fwFile').addEventListener('change', (e) => { onFwFile(e.target.files[0]); e.target.value = ''; });
  $('#fwBlock').addEventListener('change', () => {
    state.fw.block = Number($('#fwBlock').value) || 512;
    if (state.fw.source === 'bin') {
      packFwBin();
      if (state.fw.image) toast(`已按块 ${state.fw.block} 重新打包`);
    }
  });

  let versionTimer = 0;
  const onSettingsChange = () => {
    clearTimeout(versionTimer);
    versionTimer = setTimeout(() => {
      if (state.fw.source === 'bin') packFwBin();
    }, 200);
  };
  $('#fwTarget').addEventListener('change', onSettingsChange);
  $('#fwVersion').addEventListener('input', onSettingsChange);
  $('#fwVersion').addEventListener('change', () => {
    clearTimeout(versionTimer);
    if (state.fw.source === 'bin') packFwBin();
  });

  $('#btnFwDownload').addEventListener('click', downloadFw);
  $('#btnFwStart').addEventListener('click', askFwConfirm);
  $('#btnFwStop').addEventListener('click', () => abortFw('已停止'));
  $('#fwConfirmCancel').addEventListener('click', () => { $('#fwConfirm').hidden = true; });
  $('#fwConfirmOk').addEventListener('click', () => { $('#fwConfirm').hidden = true; startFw(); });
  $('#fwPacket').addEventListener('change', () => { state.fw.packetSize = Number($('#fwPacket').value) || 0; });
  $('#fwGap').addEventListener('change', () => {
    const v = Number($('#fwGap').value);
    state.fw.gap = Number.isFinite(v) ? v : 0;
  });
  $('#fwWithResp').addEventListener('change', () => { state.fw.withResponse = $('#fwWithResp').checked; });
  $('#fwVerbose').addEventListener('change', () => { state.fw.verbose = $('#fwVerbose').checked; });

  const drop = $('#fwDrop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) onFwFile(f);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.upgrading && !state.fw.wakeLock) acquireWakeLock();
  });
}

// ─────────────────── 初始化 ───────────────────
function initTabs() {
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  }));
}

function init() {
  renderKeyboard();
  $('#keyColor').innerHTML = LIGHT_COLOR_OPTIONS.map((o) => `<option value="${o.v}">${o.label}</option>`).join('');
  updateStats();
  setStatus('未连接', 'off');
  applyKeyMode();
  initTabs();
  initFwEvents();
  refreshFwHint();

  $('#btnConnect').addEventListener('click', connectDevice);
  $('#btnDisconnect').addEventListener('click', () => disconnect());
  $('#connType').addEventListener('change', updateConnTypeUi);
  updateConnTypeUi();

  $('#keyMode').addEventListener('change', (e) => {
    const prev = state.keyMode;
    state.keyMode = e.target.value;
    applyKeyMode();
    if (state.keyMode === 'check') enterLandscape();
    else if (prev === 'check') exitLandscape();
  });
  $('#keyChannel').addEventListener('change', (e) => { state.keyChannel = Number(e.target.value); });
  $('#keyVelocity').addEventListener('input', (e) => {
    state.keyVelocity = Number(e.target.value);
    $('#keyVelocityVal').textContent = e.target.value;
  });
  $('#keyColor').addEventListener('change', (e) => { state.lightColor = Number(e.target.value); });

  $('#btnAllLightsOff').addEventListener('click', () => sendMidi(allLightsOff()));
  $('#btnLightRed').addEventListener('click', (e) => lightAllKeys(1, '红', e.currentTarget));
  $('#btnLightGreen').addEventListener('click', (e) => lightAllKeys(2, '绿', e.currentTarget));
  $('#btnLightBlue').addEventListener('click', (e) => lightAllKeys(3, '蓝', e.currentTarget));
  $('#btnAllNotesOff').addEventListener('click', () => sendMidi(allNotesOff(state.keyChannel)));
  $('#btnResetCheck').addEventListener('click', resetCheck);

  const kb = $('#keyboard');
  kb.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.key'); if (!k) return;
    e.preventDefault();
    k.setPointerCapture?.(e.pointerId);
    k.classList.add('active');
    keyDown(Number(k.dataset.note));
  });
  kb.addEventListener('pointerup', (e) => {
    const k = e.target.closest('.key'); if (!k) return;
    k.classList.remove('active');
    keyUp(Number(k.dataset.note));
  });
  kb.addEventListener('pointercancel', () => {
    if (state.pointerNote !== null) keyUp(state.pointerNote);
  });
  kb.addEventListener('pointerleave', (e) => {
    const k = e.target.closest('.key'); if (!k) return;
    k.classList.remove('active');
    keyUp(Number(k.dataset.note));
  });

  $('#logToggle').addEventListener('click', () => $('#logPanel').classList.toggle('expanded'));
  $('#logPanel').querySelector('.logHead').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    $('#logPanel').classList.toggle('expanded');
  });
  $('#logClear').addEventListener('click', () => {
    state.rxCount = 0;
    state.txCount = 0;
    $('#logBody').innerHTML = '';
    updateStats();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      if (state.connected) { sendMidi(allNotesOff(state.keyChannel)); sendMidi(allLightsOff()); }
    }
  });

  addLog('··', '', '就绪。点「连接」选择 TP-01 设备。', 'sys');
}

document.addEventListener('DOMContentLoaded', init);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// 调试钩子：控制台可用 tp01simple.feedRx([0x90,60,100]) 模拟接收
window.tp01simple = {
  get state() { return state; },
  feedRx: (bytes) => handleIncoming(bytes),
  resetCheck,
  KEY_START,
  KEY_END,
  fwState: state.fw,
  fwPack: packBin,
  fwAnalyze: analyzeBle,
  fwApply: (name, bytes) => {
    const u8 = Uint8Array.from(bytes);
    if (/\.bin$/i.test(name)) loadBinFile(name, u8);
    else analyzeBleFile(name, u8);
  },
  fwPackBin: packFwBin,
  fwStart: startFw,
  fwStop: abortFw,
  fwConfirm: askFwConfirm,
};
