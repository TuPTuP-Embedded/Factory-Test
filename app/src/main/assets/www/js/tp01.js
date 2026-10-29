// 星海弹弹 TP-01 命令表 / 帧生成 / 解析
// 依据 TP-01_命令清单.md

export const FLOW = { ONE_WAY: 0x00, TWO_WAY: 0x11 };
export const SYS_EX_START = 0xf0;
export const SYS_EX_END = 0xf7;
export const VENDOR_ID = 0x00;

export const GROUPS = [
  '硬件通信',
  '灯光',
  '声音',
  '键盘',
  '双音色',
  '键盘分割',
  '鼓机',
  '节拍器',
  '自动关机',
  '弹唱 / 弹奏',
  '星云 AI',
];

const OCTAVE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(n) {
  const v = Number(n) & 0x7f;
  return OCTAVE_NAMES[v % 12] + (Math.floor(v / 12) - 1);
}

// 标准 GM 音色表（下标 = LL 值 0..127）
export const GM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'SynthStrings 1', 'SynthStrings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'SynthBrass 1', 'SynthBrass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

const ENUM = (key, label, options, def) => ({ type: 'enum', key, label, options, default: def ?? options[0].v });
const INT = (key, label, min, max, def, unit) => ({ type: 'int', key, label, min, max, default: def, unit });
const NOTE = (key, label, def) => ({ type: 'note', key, label, min: 21, max: 85, default: def ?? 60 });
const GM = (key, label, def) => ({ type: 'gm', key, label, default: def ?? 0 });
const VOLUME = (key, label, def) => ({ type: 'volume', key, label, min: 0, max: 20, default: def ?? 10 });
const SPEED = (key, label, def) => ({ type: 'speed', key, label, min: 20, max: 280, default: def ?? 80 });

const ENTER_EXIT = (key = 'LL', label = '动作', def = 1) =>
  ENUM(key, label, [{ v: 1, label: '进入 (00 01)' }, { v: 0, label: '退出 (00 00)' }], def);

const drumOptions = [{ v: 0, label: '关闭鼓机' }];
for (let i = 1; i <= 16; i++) drumOptions.push({ v: i, label: `鼓组 ${i}` });

const rhythmOptions = [
  { v: 0, label: '关闭节拍器' },
  { v: 1, label: '节奏 1' },
  { v: 2, label: '节奏 2' },
  { v: 3, label: '节奏 3' },
];

/**
 * 命令定义：
 *  major/minor/flow  帧字段
 *  hh / hhFixed      高字节字段或固定值
 *  ll                低字节字段
 */
export const COMMANDS = [
  // ── 硬件通信 0x5E ──────────────────────────────
  {
    id: 'hw.handshake', group: '硬件通信', major: 0x5e, minor: 0x01, flow: FLOW.TWO_WAY,
    name: '握手请求（查询硬件信息）', bidir: true,
    ll: { type: 'fixed', key: 'LL', label: '', value: 1, default: 1 },
  },

  // ── 灯光 0x01 ──────────────────────────────────
  {
    id: 'light.theme', group: '灯光', major: 0x01, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '设置灯光主题',
    ll: ENUM('LL', '主题', [
      { v: 1, label: '星云变换' }, { v: 2, label: '苏打薄荷' }, { v: 3, label: '柠檬气泡' },
      { v: 4, label: '蜜糖光波' }, { v: 5, label: '霓虹派对' }, { v: 6, label: '雨后彩虹' },
      { v: 7, label: '赛博朋克' },
    ], 1),
  },
  {
    id: 'light.effect', group: '灯光', major: 0x01, minor: 0x02, flow: FLOW.ONE_WAY,
    name: '设置键盘灯效',
    ll: ENUM('LL', '灯效', [
      { v: 0, label: '关闭' }, { v: 1, label: '呼吸灯效' }, { v: 2, label: '水波纹灯效' },
      { v: 3, label: '彗星灯效' }, { v: 4, label: '扩散灯效' },
    ], 1),
  },

  // ── 声音 0x02 ──────────────────────────────────
  {
    id: 'sound.volume', group: '声音', major: 0x02, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '设置音量', ll: VOLUME('LL', '音量', 10),
  },
  {
    id: 'sound.timbre', group: '声音', major: 0x02, minor: 0x02, flow: FLOW.ONE_WAY,
    name: '设置音色（GM-128）', ll: GM('LL', '音色', 25),
  },
  {
    id: 'sound.transpose', group: '声音', major: 0x02, minor: 0x03, flow: FLOW.ONE_WAY,
    name: '设置移调',
    hh: ENUM('HH', '方向', [{ v: 0, label: '升调' }, { v: 1, label: '降调' }], 0),
    ll: INT('LL', '半音数', 0, 12, 6, '半音'),
  },
  {
    id: 'sound.reverb.depth', group: '声音', major: 0x02, minor: 0x04, flow: FLOW.ONE_WAY, hhFixed: 0,
    name: '设置混响深度', ll: INT('LL', '深度', 0, 127, 112),
  },
  {
    id: 'sound.reverb.type', group: '声音', major: 0x02, minor: 0x04, flow: FLOW.ONE_WAY, hhFixed: 1,
    name: '设置混响类型',
    ll: ENUM('LL', '类型', [
      { v: 0, label: '小房间' }, { v: 1, label: '中房间' }, { v: 2, label: '大房间' }, { v: 3, label: '音乐厅' },
      { v: 4, label: '默认' }, { v: 5, label: '板式' }, { v: 6, label: '延迟' }, { v: 7, label: '左右延迟' },
    ], 5),
  },
  {
    id: 'sound.sustain', group: '声音', major: 0x02, minor: 0x05, flow: FLOW.ONE_WAY,
    name: '延音踏板',
    ll: ENUM('LL', '状态', [{ v: 0, label: '关' }, { v: 1, label: '开' }], 1),
  },

  // ── 键盘 0x03 ──────────────────────────────────
  {
    id: 'key.velocity', group: '键盘', major: 0x03, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '键盘力度',
    ll: ENUM('LL', '力度', [
      { v: 0, label: '关' }, { v: 1, label: '弱' }, { v: 2, label: '中（默认）' }, { v: 3, label: '强' },
    ], 2),
  },

  // ── 双音色 0x61 ────────────────────────────────
  {
    id: 'dual.toggle', group: '双音色', major: 0x61, minor: 0x00, flow: FLOW.TWO_WAY,
    name: '进入 / 退出双音色', bidir: true, ll: ENTER_EXIT(),
  },
  {
    id: 'dual.timbre1', group: '双音色', major: 0x61, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '双音色 · 音色一（通道 1）', ll: GM('LL', '音色', 0),
  },
  {
    id: 'dual.timbre2', group: '双音色', major: 0x61, minor: 0x02, flow: FLOW.ONE_WAY,
    name: '双音色 · 音色二（通道 2）', ll: GM('LL', '音色', 25),
  },

  // ── 键盘分割 0x62 ──────────────────────────────
  {
    id: 'split.toggle', group: '键盘分割', major: 0x62, minor: 0x00, flow: FLOW.TWO_WAY,
    name: '进入 / 退出分割模式', bidir: true, ll: ENTER_EXIT(),
  },
  {
    id: 'split.right', group: '键盘分割', major: 0x62, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '右手音色', ll: GM('LL', '音色', 0),
  },
  {
    id: 'split.left', group: '键盘分割', major: 0x62, minor: 0x02, flow: FLOW.ONE_WAY,
    name: '左手音色', ll: GM('LL', '音色', 25),
  },
  {
    id: 'split.point', group: '键盘分割', major: 0x62, minor: 0x03, flow: FLOW.ONE_WAY,
    name: '分割点', ll: NOTE('LL', '分割点', 60),
  },
  // V1.0.2 新增
  {
    id: 'split.transpose.right', group: '键盘分割', major: 0x62, minor: 0x04, flow: FLOW.ONE_WAY,
    name: '右手移调',
    hh: ENUM('HH', '方向', [{ v: 0, label: '升调' }, { v: 1, label: '降调' }], 0),
    ll: INT('LL', '半音数', 0, 12, 0, '半音'),
  },
  {
    id: 'split.transpose.left', group: '键盘分割', major: 0x62, minor: 0x05, flow: FLOW.ONE_WAY,
    name: '左手移调',
    hh: ENUM('HH', '方向', [{ v: 0, label: '升调' }, { v: 1, label: '降调' }], 0),
    ll: INT('LL', '半音数', 0, 12, 0, '半音'),
  },
  {
    id: 'split.octave.right', group: '键盘分割', major: 0x62, minor: 0x06, flow: FLOW.ONE_WAY,
    hhFixed: 0x01, name: '右手八度调节（仅降）',
    ll: INT('LL', '八度数', 0, 5, 0, '八度'),
  },
  {
    id: 'split.octave.left', group: '键盘分割', major: 0x62, minor: 0x07, flow: FLOW.ONE_WAY,
    hhFixed: 0x00, name: '左手八度调节（仅升）',
    ll: INT('LL', '八度数', 0, 5, 0, '八度'),
  },

  // ── 鼓机 0x63 ──────────────────────────────────
  {
    id: 'drum.pattern', group: '鼓机', major: 0x63, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '鼓组选择', ll: ENUM('LL', '鼓组', drumOptions, 1),
  },
  {
    id: 'drum.tempo', group: '鼓机', major: 0x63, minor: 0x02, flow: FLOW.ONE_WAY,
    name: '预设速度', ll: SPEED('LL', '速度', 80),
  },

  // ── 节拍器 0x64 ────────────────────────────────
  {
    id: 'metro.rhythm', group: '节拍器', major: 0x64, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '节奏选择', ll: ENUM('LL', '节奏', rhythmOptions, 1),
  },
  {
    id: 'metro.tempo', group: '节拍器', major: 0x64, minor: 0x02, flow: FLOW.ONE_WAY,
    name: '预设速度', ll: SPEED('LL', '速度', 80),
  },

  // ── 自动关机 0x65（V1.0.2 新增）─────────────────
  {
    id: 'auto.poweroff', group: '自动关机', major: 0x65, minor: 0x01, flow: FLOW.ONE_WAY,
    name: '自动关机设置',
    ll: ENUM('LL', '设置', [
      { v: 0, label: '不自动关机' },
      { v: 1, label: '15 分钟自动关机' },
      { v: 2, label: '30 分钟自动关机' },
    ], 0),
  },

  // ── 弹唱 / 弹奏 0x71 0x72 ──────────────────────
  {
    id: 'sing.mode', group: '弹唱 / 弹奏', major: 0x71, minor: 0x01, flow: FLOW.TWO_WAY,
    name: '跟灯弹唱', bidir: true, ll: ENTER_EXIT(),
  },
  {
    id: 'sing.run', group: '弹唱 / 弹奏', major: 0x71, minor: 0x02, flow: FLOW.TWO_WAY,
    name: '跑动', bidir: true, ll: ENTER_EXIT(),
  },
  {
    id: 'play.mode', group: '弹唱 / 弹奏', major: 0x72, minor: 0x01, flow: FLOW.TWO_WAY,
    name: '弹奏模式', bidir: true, ll: ENTER_EXIT(),
  },

  // ── 星云 AI 0x73 ───────────────────────────────
  {
    id: 'star.mode', group: '星云 AI', major: 0x73, minor: 0x01, flow: FLOW.TWO_WAY,
    name: '星云模式（预留）', bidir: true, ll: ENTER_EXIT(),
  },
];

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pick = (values, f) => (values && values[f.key] !== undefined ? values[f.key] : f.default);

/** 根据命令定义 + 当前控件值，生成 8 字节 SysEx 帧 */
export function buildFrame(cmd, values) {
  let hh = cmd.hhFixed ?? 0;
  if (cmd.hh) hh = Number(pick(values, cmd.hh)) & 0x7f;

  const f = cmd.ll;
  let ll = 0;
  if (f.type === 'fixed') {
    ll = f.value & 0x7f;
  } else if (f.type === 'speed') {
    const s = clamp(Number(pick(values, f)), f.min, f.max);
    hh = (s >> 7) & 0x7f;
    ll = s & 0x7f;
  } else {
    ll = Number(pick(values, f)) & 0x7f;
  }
  return [SYS_EX_START, VENDOR_ID, cmd.major, cmd.minor, cmd.flow, hh & 0x7f, ll & 0x7f, SYS_EX_END];
}

/** 把某个命令的某个字段值格式化成可读文本 */
function fieldText(f, hh, ll) {
  if (!f || f.type === 'fixed') return '';
  switch (f.type) {
    case 'enum': {
      const o = f.options.find((x) => x.v === ll);
      return o ? o.label : `LL=${ll}`;
    }
    case 'gm':
      return GM_NAMES[ll] || `音色 ${ll}`;
    case 'note':
      return `${noteName(ll)} (${ll})`;
    case 'volume':
      return `${Math.round((ll / 20) * 100)}% (LL=${ll})`;
    case 'speed':
      return `${hh * 128 + ll} (HH=${hh} LL=${ll})`;
    case 'int':
    default:
      return `${ll}${f.unit ? ' ' + f.unit : ''} (LL=${ll})`;
  }
}

const CMD_BY_KEY = new Map();
for (const c of COMMANDS) {
  const k = `${c.major}-${c.minor}`;
  if (!CMD_BY_KEY.has(k)) CMD_BY_KEY.set(k, []);
  CMD_BY_KEY.get(k).push(c);
}

function findCommand(major, minor, hh) {
  const list = CMD_BY_KEY.get(`${major}-${minor}`);
  if (!list) return null;
  if (list.length === 1) return list[0];
  const byFixed = list.find((c) => c.hhFixed !== undefined && c.hhFixed === hh);
  return byFixed || list[0];
}

function decodeHandshake(bytes) {
  if (bytes.length < 16) return '握手应答 (数据不足)';
  const d = bytes.slice(5, 15);
  const theme = ['—', '星云变换', '苏打薄荷', '柠檬气泡', '蜜糖光波', '霓虹派对', '雨后彩虹', '赛博朋克'][d[0]] || `主题${d[0]}`;
  const eff = ['关闭', '呼吸', '水波纹', '彗星', '扩散'][d[1]] || `灯效${d[1]}`;
  const timbre = GM_NAMES[d[3]] || `音色${d[3]}`;
  const sustain = d[4] ? '开' : '关';
  const metro = d[5] ? '启动' : '关';
  const fw = `V${d[6]}.${d[7]}.${d[8]}`;
  const battery = d[9];
  return `握手应答 · 主题=${theme} 灯效=${eff} 音色=${timbre} 延音=${sustain} 节拍器=${metro} 固件=${fw} 电量=${battery}`;
}

const LIGHT_COLORS = ['熄灭', '红', '绿', '蓝', '黄', '紫', '青', '白'];

/** 把一条 MIDI 消息翻译成可读文本（含 TP-01 私有命令识别） */
export function describeMessage(bytes) {
  const b = bytes instanceof Uint8Array ? Array.from(bytes) : bytes.slice();
  if (b.length === 0) return '';

  // TP-01 SysEx
  if (b[0] === SYS_EX_START && b[1] === VENDOR_ID) {
    const major = b[2], minor = b[3], flow = b[4], hh = b[5], ll = b[6];
    if (major === 0x5e && minor === 0x01 && b.length >= 16) return decodeHandshake(b);
    const cmd = findCommand(major, minor, hh);
    const flowTag = flow === FLOW.TWO_WAY ? '双向' : '单向';
    if (cmd) {
      const parts = [];
      if (cmd.hh && cmd.hh.type === 'enum') {
        const ho = cmd.hh.options.find((o) => o.v === hh);
        if (ho) parts.push(ho.label);
      }
      const txt = fieldText(cmd.ll, hh, ll);
      if (txt) parts.push(txt);
      return `TP-01 ${cmd.name}${parts.length ? ' · ' + parts.join(' ') : ''} [${flowTag}]`;
    }
    return `TP-01 未识别命令 大类=0x${major.toString(16).padStart(2, '0')} 子类=0x${minor.toString(16).padStart(2, '0')} HH=0x${hh.toString(16).padStart(2, '0')} LL=0x${ll.toString(16).padStart(2, '0')}`;
  }

  const status = b[0];
  const hi = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  if (hi === 0xa0) {
    const on = (status & 0x01) === 1;
    return `灯光 ${on ? '开灯' : '关灯'}  ${noteName(b[1])}  ${LIGHT_COLORS[b[2]] ?? '色' + b[2]}`;
  }
  switch (hi) {
    case 0x80: return `Note Off  ch${ch}  ${noteName(b[1])}  vel=${b[2]}`;
    case 0x90: return b[2] === 0
      ? `Note Off  ch${ch}  ${noteName(b[1])}`
      : `Note On   ch${ch}  ${noteName(b[1])}  vel=${b[2]}`;
    case 0xb0: return `CC  ch${ch}  #${b[1]} = ${b[2]}`;
    case 0xc0: return `Program Change  ch${ch}  ${GM_NAMES[b[1]] || b[1]}`;
    case 0xd0: return `Channel Aftertouch  ch${ch}  ${b[1]}`;
    case 0xe0: return `Pitch Bend  ch${ch}  ${(b[2] << 7) | b[1]}`;
    default:
      break;
  }
  if (status >= 0xf8) {
    const names = { 0xf8: 'Timing Clock', 0xfa: 'Start', 0xfb: 'Continue', 0xfc: 'Stop', 0xfe: 'Active Sensing', 0xff: 'System Reset' };
    return names[status] || `实时 0x${status.toString(16)}`;
  }
  if (status === 0xf0) return `SysEx (${b.length} 字节)`;
  return `0x${status.toString(16)}`;
}

// ── Hex 工具 ─────────────────────────────────────
export function bytesToHex(bytes) {
  return Array.from(bytes).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
export function hexToBytes(str) {
  const clean = String(str).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Hex 长度为奇数');
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

// ── 灯光控制 MIDI Event（清单第 5 节）─────────────
export const LIGHT_COLOR_OPTIONS = [
  { v: 1, label: '红' }, { v: 2, label: '绿' }, { v: 3, label: '蓝' }, { v: 4, label: '黄' },
  { v: 5, label: '紫' }, { v: 6, label: '青' }, { v: 7, label: '白' },
];
export function lightOn(note, color) { return [0xa1, note & 0x7f, color & 0x7f]; }
export function lightOff(note, color = 0) { return [0xa0, note & 0x7f, color & 0x7f]; }
export function allLightsOff() { return [0xa0, 0x00, 0x00]; }
export function noteOn(note, vel = 100, ch = 1) { return [0x90 | ((ch - 1) & 0x0f), note & 0x7f, vel & 0x7f]; }
export function noteOff(note, ch = 1) { return [0x80 | ((ch - 1) & 0x0f), note & 0x7f, 0x00]; }
export function allNotesOff(ch = 1) { return [0xb0 | ((ch - 1) & 0x0f), 0x7b, 0x00]; }

// ── 内置预设按钮 ─────────────────────────────────
export const BUILTIN_PRESETS = [
  { group: '常用', label: '握手（查询硬件信息）', hex: 'F0 00 5E 01 11 00 01 F7' },
  { group: '常用', label: '全部熄灭', hex: 'A0 00 00' },
  { group: '常用', label: 'All Notes Off', hex: 'B0 7B 00' },
  { group: '常用', label: '系统复位', hex: 'FF' },
  { group: '灯光', label: '主题 · 星云变换', hex: 'F0 00 01 01 00 00 01 F7' },
  { group: '灯光', label: '灯效 · 扩散', hex: 'F0 00 01 02 00 00 04 F7' },
  { group: '声音', label: '音量 · 50%', hex: 'F0 00 02 01 00 00 0A F7' },
  { group: '声音', label: '音色 · 钢弦吉他', hex: 'F0 00 02 02 00 00 19 F7' },
  { group: '双音色', label: '进入双音色', hex: 'F0 00 61 00 11 00 01 F7' },
  { group: '双音色', label: '退出双音色', hex: 'F0 00 61 00 11 00 00 F7' },
  { group: '键盘分割', label: '进入分割模式', hex: 'F0 00 62 00 11 00 01 F7' },
  { group: '键盘分割', label: '分割点 · C4', hex: 'F0 00 62 03 00 00 3C F7' },
];
