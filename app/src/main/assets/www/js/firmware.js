// 固件升级（蓝牙 IAP）—— .ble 帧解析、.BIN 打包、应答解析、传输状态机
// 协议：手机 → 琴  F0 7D 58 48 <7 位编码 body> F7
//       琴 → 手机  F0 7D 58 49 ST n0 n1 n2 n3 F7
// 手机只负责「切成等长帧、一帧一帧发、按琴的回复决定发哪一帧」，不解析内容、不算校验。

export const FW_SEND_HEAD = [0xf0, 0x7d, 0x58, 0x48];
export const FW_REPLY_HEAD = [0xf0, 0x7d, 0x58, 0x49];

export const FW_TARGETS = {
  APP_: '主板程序',
  KEY_: '琴键板程序',
  RES_: '字库',
  IMG_: '图片',
  MID_: '伴奏曲库',
};

export const FW_ERROR_TEXT = {
  0x10: '升级文件格式不对（.ble 损坏或工具版本不对）',
  0x11: '升级文件名不对',
  0x12: '琴的存储空间不足（需售后处理）',
  0x13: '琴写入失败（重试一次；仍失败联系售后）',
  0x14: '文件校验失败（传输中数据有误，请重新升级）',
};

export const FW_BLOCK_SIZES = [64, 128, 256, 512];
export const FW_MAX_BIN = 2_064_384;
export const FW_ST = { NEXT: 0x00, DONE: 0x01, WAIT: 0x02 };

export class FwError extends Error {}

// ────────────────────────── 校验算法 ──────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32（与 zlib.crc32 相同） */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-16/XMODEM（多项式 0x1021，初值 0） */
export function crc16Xmodem(data, crc = 0) {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

/** 7 位编码：body 每 7 字节一组，先发高位字节，再发低 7 位 */
export function encode7(body) {
  const out = new Uint8Array(Math.ceil(body.length / 7) * 8);
  let o = 0;
  for (let i = 0; i < body.length; i += 7) {
    const n = Math.min(7, body.length - i);
    let hi = 0;
    for (let j = 0; j < n; j++) if (body[i + j] & 0x80) hi |= 1 << j;
    out[o++] = hi;
    for (let j = 0; j < n; j++) out[o++] = body[i + j] & 0x7f;
  }
  return out.subarray(0, o);
}

/** 7 位解码 */
export function decode7(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 8) {
    const hi = data[i];
    const n = Math.min(7, data.length - i - 1);
    for (let j = 0; j < n; j++) out.push(data[i + 1 + j] | (hi & (1 << j) ? 0x80 : 0));
  }
  return Uint8Array.from(out);
}

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b) => {
  let s = '';
  for (const c of b) {
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

// ────────────────────────── .bin → .ble ──────────────────────────
/** 有 16 字节头的固定标记（FF FF 00 00），不校验长度字段 */
export function hasBinMarker(data) {
  return data.length >= 16
    && data[12] === 0xff && data[13] === 0xff && data[14] === 0x00 && data[15] === 0x00;
}

/** 是否已带 16 字节升级文件头（长度字段 = 文件大小 - 16，且有 FF FF 00 00 标记） */
export function hasBinHeader(data) {
  return hasBinMarker(data) && u32le(data, 0) === data.length - 16;
}

/** 严格检查 16 字节文件头（长度 / 累加和 / 版本），返回版本号 */
export function inspectBin(data) {
  if (data.length < 16) throw new FwError('文件太短，缺少 16 字节文件头');
  if (!hasBinMarker(data)) {
    throw new FwError('缺少 16 字节文件头（请先用 iap_pack.py / res_pack.py 等工具打包）');
  }
  if (u32le(data, 0) !== data.length - 16) {
    throw new FwError('16 字节头里的程序长度与文件大小不符，文件可能损坏');
  }
  const csum = u32le(data, 4);
  const version = u32le(data, 8);
  let sum = 0;
  for (let i = 16; i < data.length; i++) sum = (sum + data[i]) >>> 0;
  if (sum !== csum) throw new FwError('16 字节头里的累加和与内容不符，文件可能损坏');
  if (version === 0) throw new FwError('版本号不能为 0');
  return { version, length: data.length - 16 };
}

/** 第 1 步（与 iap_pack.py 相同）：长度 + 累加和 + 版本号 + FF FF 00 00 + 原程序 */
export function addBinHeader(prog, version) {
  if (!Number.isInteger(version) || version <= 0 || version > 0xffffffff) {
    throw new FwError('版本号必须是 1～4294967295 的整数');
  }
  if (!prog || !prog.length) throw new FwError('程序文件是空的');
  const out = new Uint8Array(16 + prog.length);
  out[0] = prog.length & 0xff;
  out[1] = (prog.length >>> 8) & 0xff;
  out[2] = (prog.length >>> 16) & 0xff;
  out[3] = (prog.length >>> 24) & 0xff;
  let sum = 0;
  for (let i = 0; i < prog.length; i++) sum = (sum + prog[i]) >>> 0;
  out[4] = sum & 0xff;
  out[5] = (sum >>> 8) & 0xff;
  out[6] = (sum >>> 16) & 0xff;
  out[7] = (sum >>> 24) & 0xff;
  out[8] = version & 0xff;
  out[9] = (version >>> 8) & 0xff;
  out[10] = (version >>> 16) & 0xff;
  out[11] = (version >>> 24) & 0xff;
  out[12] = 0xff;
  out[13] = 0xff;
  out[14] = 0x00;
  out[15] = 0x00;
  out.set(prog, 16);
  return out;
}

/** 粗查是不是 Cortex-M 程序（栈顶在 RAM 0x20xxxxxx，复位入口在 Flash 0x08xxxxxx） */
export function firmwareWarning(prog) {
  if (!prog || prog.length < 8) return '文件太短，不像是程序';
  const sp = u32le(prog, 0);
  const reset = u32le(prog, 4);
  if ((sp >>> 24) !== 0x20 || (reset >>> 24) !== 0x08 || !(reset & 1)) {
    const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');
    return `文件开头不像单片机程序的向量表（栈顶 ${hex(sp)}，复位入口 ${hex(reset)}），请确认选对了文件`;
  }
  return '';
}

/** 从当前文件名识别升级对象前缀；识别不出返回 '' */
export function detectBinaryPrefix(name) {
  const up = String(name || '').toUpperCase();
  for (const p of Object.keys(FW_TARGETS)) if (up.startsWith(p)) return p;
  return '';
}

/** 猜升级对象（与 PC 工具规则相同：KEY / F011 认为是琴键板，其余按主板） */
export function guessBinaryPrefix(name) {
  const up = String(name || '').toUpperCase();
  if (up.startsWith('KEY') || up.includes('F011') || up.includes('KEY')) return 'KEY_';
  return 'APP_';
}

/** 生成 8.3 合规文件名，如 APP_V101.BIN */
export function makeBinName(prefix, version) {
  return `${prefix}V${version}.BIN`;
}

/** 检查带 16 字节头的 .BIN 升级文件，返回版本号 */
export function checkBin(name, data) {
  const up = String(name || '').toUpperCase();
  const prefix = up.slice(0, 4);
  if (!FW_TARGETS[prefix]) {
    throw new FwError(`文件名必须以 APP_ / KEY_ / RES_ / IMG_ / MID_ 开头：${name || '(未命名)'}`);
  }
  if (!/^[A-Z0-9_-]{1,8}\.BIN$/.test(up)) {
    throw new FwError('文件名不符合 8.3 规则（点号前最多 8 个字符，扩展名 .BIN）');
  }
  if (data.length > FW_MAX_BIN) {
    throw new FwError(`文件太大：${data.length} 字节，上限 ${FW_MAX_BIN} 字节`);
  }
  const { version } = inspectBin(data);
  return version;
}

/**
 * 把带 16 字节头的 .BIN 打成 .ble（与 PC 工具 ble_pack.py 规则一致）
 * @returns {{bytes: Uint8Array, L: number, N: number, block: number, filename: string, version: number}}
 */
export function packBin(name, input, block = 512) {
  if (!FW_BLOCK_SIZES.includes(block)) throw new FwError('块大小只能是 64 / 128 / 256 / 512');
  const data = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const version = checkBin(name, data);
  const filename = String(name).toUpperCase();

  const bodyLen = 4 + block + 2;
  const encodedLen = bodyLen + Math.ceil(bodyLen / 7);
  const L = FW_SEND_HEAD.length + encodedLen + 1;
  const blocks = Math.ceil(data.length / block);
  const N = blocks + 1;
  const out = new Uint8Array(N * L);

  const info = new Uint8Array(28);
  info[0] = 1;                                  // 协议版本
  info[2] = block & 0xff;                       // 每帧数据字节数
  info[3] = (block >> 8) & 0xff;
  const put32 = (arr, off, v) => {
    arr[off] = v & 0xff;
    arr[off + 1] = (v >>> 8) & 0xff;
    arr[off + 2] = (v >>> 16) & 0xff;
    arr[off + 3] = (v >>> 24) & 0xff;
  };
  put32(info, 4, data.length);
  put32(info, 8, crc32(data));
  put32(info, 12, N);
  for (let i = 0; i < Math.min(12, filename.length); i++) info[16 + i] = filename.charCodeAt(i);

  for (let k = 0; k < N; k++) {
    const body = new Uint8Array(bodyLen);
    put32(body, 0, k);
    if (k === 0) {
      body.set(info, 4);
      body.fill(0xff, 4 + info.length);
    } else {
      const start = (k - 1) * block;
      const chunk = data.subarray(start, Math.min(start + block, data.length));
      body.set(chunk, 4);
      body.fill(0xff, 4 + chunk.length);
    }
    const c = crc16Xmodem(body.subarray(0, bodyLen - 2));
    body[bodyLen - 2] = c & 0xff;
    body[bodyLen - 1] = (c >> 8) & 0xff;

    const off = k * L;
    out.set(FW_SEND_HEAD, off);
    out.set(encode7(body), off + FW_SEND_HEAD.length);
    out[off + L - 1] = 0xf7;
  }

  return { bytes: out, L, N, block, filename, version, fileLen: data.length };
}

// ────────────────────────── .ble 解析 / 自检 ──────────────────────────
/**
 * 解析并完整自检一个 .ble（帧头、帧尾、7 位编码、每帧 CRC16、帧号、整体 CRC-32、版本号）
 * @returns 解析结果；ok=false 时 problem 为中文原因
 */
export function analyzeBle(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const base = {
    ok: false, problem: '', warn: '', bytes, L: 0, N: 0,
    filename: '', target: '', block: 0, fileLen: 0, crc32: 0, version: null,
  };
  const fail = (problem, extra = {}) => ({ ...base, ...extra, ok: false, problem });

  if (bytes.length > 4 * 1024 * 1024) {
    return fail(`文件太大（${(bytes.length / 1048576).toFixed(1)} MB），升级包应在 2 MB 以内`);
  }

  const pos = bytes.indexOf(0xf7);
  if (pos < 9) return fail('不是升级包：找不到帧结束符 F7');
  const L = pos + 1;
  if (L < 12) return fail(`帧长 ${L} 字节太短，文件可能损坏`, { L });
  if (bytes.length % L !== 0) {
    return fail(`文件大小 ${bytes.length} 字节不是帧长 ${L} 的整数倍，文件可能损坏`, { L });
  }
  const N = bytes.length / L;
  if (N < 2) return fail('升级包帧数不足', { L, N });

  const frameBody = (k) => {
    const off = k * L;
    if (bytes[off] !== 0xf0 || bytes[off + 1] !== 0x7d || bytes[off + 2] !== 0x58 || bytes[off + 3] !== 0x48) {
      throw new FwError(`第 ${k} 帧开头不是 F0 7D 58 48`);
    }
    if (bytes[off + L - 1] !== 0xf7) throw new FwError(`第 ${k} 帧结尾不是 F7`);
    for (let i = off + 4; i < off + L - 1; i++) {
      if (bytes[i] & 0x80) throw new FwError(`第 ${k} 帧包含非法字节（≥0x80），7 位编码可能损坏`);
    }
    return decode7(bytes.subarray(off + 4, off + L - 1));
  };

  let info;
  try {
    info = frameBody(0);
  } catch (e) {
    return fail(e.message, { L, N });
  }
  if (info.length < 6 + 4) return fail('第 0 帧太短，缺少文件信息', { L, N });
  if (u32le(info, 0) !== 0) return fail('第 0 帧帧号不是 0，文件顺序错误', { L, N });

  const block = u16le(info, 6);
  const fileLen = u32le(info, 8);
  const fileCrc = u32le(info, 12);
  const declaredN = u32le(info, 16);
  const filename = ascii(info.subarray(20, 32));

  if (info.length !== 6 + block) return fail('第 0 帧记录的数据块大小与帧长不符', { L, N, block });
  if (declaredN !== N) return fail(`第 0 帧记录总帧数 ${declaredN}，实际 ${N}，文件可能损坏`, { L, N, block });
  if (!filename) return fail('第 0 帧没有文件名', { L, N, block });
  if (!FW_BLOCK_SIZES.includes(block)) return fail(`数据块大小 ${block} 不受支持（应为 64/128/256/512）`, { L, N, block });
  if (fileLen <= block * (N - 1) - block || fileLen > block * (N - 1)) {
    // 允许最后一帧有 FF 填充，但长度必须落在合理范围
    return fail(`文件长度 ${fileLen} 与帧数 ${N} 不匹配，文件可能损坏`, { L, N, block });
  }

  // 逐帧校验 CRC16 与帧号，同时拼出文件内容
  const data = new Uint8Array(block * (N - 1));
  try {
    const c0 = crc16Xmodem(info.subarray(0, info.length - 2));
    if (c0 !== u16le(info, info.length - 2)) throw new FwError('第 0 帧 CRC16 校验失败');
    for (let k = 1; k < N; k++) {
      const body = frameBody(k);
      if (body.length !== 6 + block) throw new FwError(`第 ${k} 帧长度不对`);
      if (u32le(body, 0) !== k) throw new FwError(`第 ${k} 帧帧号不对`);
      const c = crc16Xmodem(body.subarray(0, body.length - 2));
      if (c !== u16le(body, body.length - 2)) throw new FwError(`第 ${k} 帧 CRC16 校验失败`);
      data.set(body.subarray(4, 4 + block), (k - 1) * block);
    }
  } catch (e) {
    return fail(e.message, { L, N, block });
  }

  const actual = crc32(data.subarray(0, fileLen));
  if (actual !== fileCrc) {
    return fail(`整体 CRC-32 校验失败（记录 ${fileCrc.toString(16).toUpperCase()}，实际 ${actual.toString(16).toUpperCase()}）`, { L, N, block, filename, fileLen });
  }

  let version = null;
  let warn = '';
  if (fileLen >= 16 && data[12] === 0xff && data[13] === 0xff && data[14] === 0 && data[15] === 0
    && u32le(data, 0) === fileLen - 16) {
    version = u32le(data, 8);
  } else {
    warn = '数据里没有找到 16 字节 .BIN 文件头，版本号未知（琴可能会拒绝安装）';
  }

  const prefix = filename.toUpperCase().slice(0, 4);
  const image = {
    ok: true, problem: '', warn, bytes, L, N, filename,
    target: FW_TARGETS[prefix] || '未知对象', block, fileLen, crc32: fileCrc, version,
    frame: (k) => bytes.subarray(k * L, (k + 1) * L),
  };
  return image;
}

// ────────────────────────── 应答解析 ──────────────────────────
/** 解析琴的 10 字节升级应答；不是升级应答返回 null */
export function parseReply(bytes) {
  if (!bytes || bytes.length !== 10) return null;
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x7d || bytes[2] !== 0x58 || bytes[3] !== 0x49 || bytes[9] !== 0xf7) return null;
  for (let i = 4; i < 9; i++) if (bytes[i] & 0x80) return null;
  return {
    st: bytes[4],
    next: bytes[5] | (bytes[6] << 7) | (bytes[7] << 14) | (bytes[8] << 21),
  };
}

export function describeFwReply(r) {
  if (!r) return '';
  if (r.st === FW_ST.NEXT) return `请发第 ${r.next} 帧`;
  if (r.st === FW_ST.DONE) return '升级完成';
  if (r.st === FW_ST.WAIT) return '稍等（琴正在重启）';
  return `错误 0x${r.st.toString(16).toUpperCase().padStart(2, '0')}：${FW_ERROR_TEXT[r.st] || '未知错误'}`;
}

// ────────────────────────── 传输状态机 ──────────────────────────
/**
 * 一次升级的发送流程。严格照协议：
 *   - 帧 0 等 1 秒、其他帧等 2 秒回复，超时就重发同一帧
 *   - 发哪一帧以琴的回复为准（断点续传 / 重发）
 *   - ST=02 每秒重发第 0 帧；ST=01 成功；ST≥10 失败
 *   - 连续 60 秒无回复判失败
 * 与传输层解耦：sendFrame(k, frameBytes) 与 feedReply(bytes) 由外部提供。
 */
export class UpgradeSession {
  constructor({ image, sendFrame, onEvent = () => {}, timings = {} }) {
    this.image = image;
    this.sendFrame = sendFrame;
    this.onEvent = onEvent;
    this.frame0Timeout = timings.frame0Timeout ?? 1000;
    this.frameTimeout = timings.frameTimeout ?? 2000;
    this.noResponseLimit = timings.noResponseLimit ?? 60000;
    this.queue = [];
    this.waiter = null;
    this.canceled = false;
    this.interruptReason = null;
    this.sent = 0;
    this.resent = 0;
    this.running = false;
  }

  _emit(type, ...args) {
    try { this.onEvent(type, ...args); } catch {}
  }

  _push(item) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else {
      this.queue.push(item);
    }
  }

  _wait(ms) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiter = null; resolve(null); }, ms);
      this.waiter = (v) => { clearTimeout(t); this.waiter = null; resolve(v); };
    });
  }

  /** 收到一条 10 字节升级应答；不是升级应答返回 false */
  feedReply(bytes) {
    const r = parseReply(bytes);
    if (!r) return false;
    this._emit('reply', r);
    this._push({ type: 'reply', ...r });
    return true;
  }

  /** 用户停止 */
  cancel() {
    this.canceled = true;
    this._push({ type: 'wake' });
  }

  /** 断线 / 发送失败等外部中断，run() 会返回 interrupted */
  interrupt(reason = 'interrupted') {
    if (this.interruptReason) return;
    this.interruptReason = reason;
    this._push({ type: 'wake' });
  }

  /** 跑完返回 { ok, canceled, interrupted, error?, st? } */
  async run() {
    const { image } = this;
    const { N, L } = image;
    const target = image.target;
    this.running = true;
    this.queue.length = 0;

    let k = 0;
    let pending = true;
    let waitTo = this.frame0Timeout;
    let lastK = -1;
    let tSent = 0;
    let lastReply = Date.now();
    let started = null;
    let baseNext = 0;

    const finish = (res) => {
      this.running = false;
      return res;
    };

    this._emit('status', '正在连接琴…');
    this._emit('progress', 0, image.N - 1);
    this._emit('log', `开始升级 ${target}：${image.filename}（${N} 帧 × ${L} 字节）`);

    for (;;) {
      if (this.canceled) return finish({ ok: false, canceled: true });
      if (this.interruptReason) return finish({ ok: false, interrupted: this.interruptReason });

      const now = Date.now();
      if (now - lastReply > this.noResponseLimit) {
        return finish({
          ok: false,
          error: `琴没有响应（${Math.round(this.noResponseLimit / 1000)} 秒无回复），请检查蓝牙连接、靠近琴后重试`,
        });
      }

      let timeout;
      if (pending) {
        if (k < N) {
          try {
            await this.sendFrame(k, image.frame(k));
          } catch (e) {
            if (this.canceled) return finish({ ok: false, canceled: true });
            const reason = e && e.restart ? 'restart' : 'send';
            this._emit('log', `第 ${k} 帧发送失败：${(e && e.message) || e}`);
            return finish({ ok: false, interrupted: reason, k, error: (e && e.message) || String(e) });
          }
          tSent = Date.now();
          this.sent++;
          if (k === lastK) this.resent++;
          lastK = k;
          if (k === 0 || k % 20 === 0) this._emit('log', `→ 第 ${k} 帧`);
        }
        timeout = k === 0 ? this.frame0Timeout : this.frameTimeout;
      } else {
        timeout = waitTo;
      }

      const item = await this._wait(timeout);
      if (this.canceled) return finish({ ok: false, canceled: true });
      if (this.interruptReason) return finish({ ok: false, interrupted: this.interruptReason });

      if (!item || item.type !== 'reply') {
        pending = true;
        continue;
      }

      lastReply = Date.now();
      const { st, next } = item;

      if (st === FW_ST.NEXT) {
        if (started === null) {
          started = Date.now();
          baseNext = next;
          if (next > 1) this._emit('log', `琴要求从第 ${next} 帧接着发（断点续传）`);
        }
        k = next;
        pending = true;
        const done = Math.max(next - 1, 0);
        const total = Math.max(N - 1, 0);
        const frac = total > 0 ? Math.min(Math.max(done / total, 0), 1) : 1;
        let extra = '';
        const el = (Date.now() - started) / 1000;
        if (el > 1 && next > baseNext) {
          const fps = (next - baseNext) / el;
          const rest = fps > 0 ? (N - next) / fps : 0;
          extra = `${(fps * L / 1024).toFixed(1)} KB/s，剩余约 ${fmtSecs(rest)}`;
        }
        this._emit('status', `正在升级 ${target}  ${done} / ${total} 帧`);
        this._emit('progress', done, total, extra);
      } else if (st === FW_ST.WAIT) {
        this._emit('status', '琴正在重启进入升级模式…');
        this._emit('log', '琴回复"稍等"，每秒重发第 0 帧');
        k = 0;
        pending = false;
        waitTo = Math.max(50, this.frame0Timeout - (Date.now() - tSent));
      } else if (st === FW_ST.DONE) {
        this._emit('progress', image.N - 1, image.N - 1);
        this._emit('status', '升级成功，琴正在重启安装，请勿关机');
        this._emit('log', `完成：${image.filename}。共发送 ${this.sent} 帧（重发 ${this.resent} 次）`);
        return finish({ ok: true, sent: this.sent, resent: this.resent });
      } else {
        return finish({
          ok: false,
          st,
          k: lastK,
          error: `升级失败（错误码 0x${st.toString(16).toUpperCase().padStart(2, '0')}）：${FW_ERROR_TEXT[st] || '未知错误'}`,
        });
      }
    }
  }
}

export function fmtSecs(s) {
  const v = Math.max(0, Math.round(s));
  return v >= 60 ? `${Math.floor(v / 60)} 分 ${String(v % 60).padStart(2, '0')} 秒` : `${v} 秒`;
}
