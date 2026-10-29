// BLE-MIDI 1.0 编解码
// 参考：Specification for MIDI over Bluetooth Low Energy (BLE-MIDI) 1.0

export const MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const MIDI_CHAR_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';

// 最小 ATT MTU(23) - 3 = 20 字节负载，永远合法
export const MAX_PACKET = 20;

const toU8 = (v) => (v instanceof Uint8Array ? v : Uint8Array.from(v));

/**
 * 把 MIDI 字节编码成 BLE-MIDI 包（每包 <= maxPacket）。
 * - 普通消息：header + 时间戳 + 数据
 * - SysEx：首包 header+时间戳+数据；续包仅 header（不带时间戳）+ 数据
 * @param {number[]|Uint8Array} midiIn MIDI 字节（SysEx 需含 F0..F7）
 * @param {number} tsMs 13 位毫秒时间戳
 * @param {number} maxPacket 单包上限（默认 20；固件升级时可放大到协商 MTU - 3）
 * @returns {Uint8Array[]} 待写入 characteristic 的包
 */
export function encodePackets(midiIn, tsMs = 0, maxPacket = MAX_PACKET) {
  const midi = toU8(midiIn);
  if (midi.length === 0) return [];
  const ts = tsMs & 0x1fff;
  const header = 0x80 | ((ts >> 7) & 0x3f);
  const tsByte = 0x80 | (ts & 0x7f);
  const cap0 = Math.max(MAX_PACKET, Math.floor(maxPacket) || MAX_PACKET);

  const isSysEx = midi[0] === 0xf0;

  if (!isSysEx) {
    const p = new Uint8Array(2 + midi.length);
    p[0] = header;
    p[1] = tsByte;
    p.set(midi, 2);
    return [p];
  }

  const packets = [];
  let off = 0;
  let first = true;
  while (off < midi.length) {
    const overhead = first ? 2 : 1;
    const cap = cap0 - overhead;
    const len = Math.min(cap, midi.length - off);
    const p = new Uint8Array(overhead + len);
    p[0] = header;
    if (first) p[1] = tsByte;
    p.set(midi.subarray(off, off + len), overhead);
    packets.push(p);
    off += len;
    first = false;
  }
  return packets;
}

// 每种状态字节的消息长度（含状态字节）
function statusLength(status) {
  if (status >= 0xf0) {
    switch (status) {
      case 0xf1:
      case 0xf3:
        return 2;
      case 0xf2:
        return 3;
      case 0xf6:
        return 1;
      default:
        return 1;
    }
  }
  const hi = status & 0xf0;
  if (hi === 0xc0 || hi === 0xd0) return 2;
  return 3;
}

/**
 * 流式解码 BLE-MIDI 数据。
 * 每次收到通知把整包 push 进来，通过 onMessage 回调得到一条条 MIDI 消息。
 */
export class BLEMidiDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.reset();
  }

  reset() {
    this.runningStatus = 0;
    this.ts = 0;
    this.sysEx = null;
    this.msg = null;
  }

  emit(message) {
    this.onMessage({ message, timestamp: this.ts });
  }

  push(input) {
    const b = toU8(input);
    if (b.length === 0 || (b[0] & 0x80) === 0) return;

    const tsHigh = b[0] & 0x3f;
    this.ts = (tsHigh << 7) | (this.ts & 0x7f);
    let i = 1;

    // BLE-MIDI：每个包 header 后紧跟一个时间戳字节（0x80~0xFF）。
    // SysEx 续包通常直接跟数据（<0x80），但 TP-01 的蓝牙模块会在续包里带时间戳。
    if (i < b.length && b[i] & 0x80) {
      this.ts = (tsHigh << 7) | (b[i] & 0x7f);
      i++;
    }

    for (; i < b.length; i++) {
      const byte = b[i];
      if (byte & 0x80) {
        // MSB=1
        if (this.sysEx) {
          if (byte === 0xf7) {
            this.sysEx.push(0xf7);
            this.emit(Uint8Array.from(this.sysEx));
            this.sysEx = null;
          } else if (byte >= 0xf8) {
            // 系统实时消息可内嵌于 SysEx（前面会带时间戳，此处忽略该时间戳）
            this.emit(Uint8Array.from([byte]));
          }
          // 其余 0x80..0xF7：SysEx 续包里的时间戳字节，跳过（不能并入 SysEx 数据）
          continue;
        }
        // 系统实时消息（单字节，可内嵌）
        if (byte >= 0xf8) {
          this.emit(Uint8Array.from([byte]));
          continue;
        }
        // SysEx 起始
        if (byte === 0xf0) {
          this.sysEx = [0xf0];
          continue;
        }
        // 其余：MIDI 状态字节（0x80..0xEF 通道消息、0xF1..0xF7 系统公共）
        this.startMessage(byte);
        continue;
      }
      // 数据字节
      this.dataByte(byte);
    }
  }

  startMessage(status) {
    this.runningStatus = status;
    const len = statusLength(status);
    this.msg = [status];
    if (len <= 1) {
      this.emit(Uint8Array.from(this.msg));
      this.msg = null;
    }
  }

  dataByte(byte) {
    if (this.sysEx) {
      this.sysEx.push(byte);
      return;
    }
    let status;
    if (this.msg) {
      this.msg.push(byte);
      if (this.msg.length >= statusLength(this.msg[0])) {
        this.emit(Uint8Array.from(this.msg));
        this.msg = null;
      }
      return;
    }
    if (this.runningStatus) {
      this.msg = [this.runningStatus, byte];
      if (this.msg.length >= statusLength(this.runningStatus)) {
        this.emit(Uint8Array.from(this.msg));
        this.msg = null;
      }
    }
  }
}
