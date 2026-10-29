// Native Android Bridge Polyfill for TP-01 Simple APK
// Bridges navigator.bluetooth, navigator.requestMIDIAccess, screen.orientation, navigator.wakeLock, and Blob downloads to Android Native APIs
(function () {
  if (!window.AndroidNative) return;

  const MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
  const MIDI_CHAR_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function u8ToB64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }

  const callbacks = new Map();
  let reqSeq = 1;
  function callAsync(fn, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = String(reqSeq++);
      const timer = timeoutMs > 0 ? setTimeout(() => {
        callbacks.delete(id);
        reject(new Error('操作超时'));
      }, timeoutMs) : null;
      callbacks.set(id, {
        resolve: (val) => { if (timer) clearTimeout(timer); resolve(val); },
        reject: (err) => { if (timer) clearTimeout(timer); reject(err); }
      });
      try {
        fn(id);
      } catch (e) {
        if (timer) clearTimeout(timer);
        callbacks.delete(id);
        reject(e);
      }
    });
  }

  let activeBleDevice = null;
  let activeBleChar = null;
  let activeMidiAccess = null;

  class NativeBluetoothCharacteristic {
    constructor(service) {
      this.service = service;
      this.uuid = MIDI_CHAR_UUID;
      this.properties = { writeWithoutResponse: true, write: true, notify: true };
      this.value = new DataView(new ArrayBuffer(0));
      this._listeners = new Set();
    }
    async startNotifications() {
      await callAsync((id) => window.AndroidNative.bleStartNotifications(id), 10000);
      return this;
    }
    async stopNotifications() {
      try { window.AndroidNative.bleStopNotifications(); } catch {}
      return this;
    }
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged' && typeof fn === 'function') {
        this._listeners.add(fn);
      }
    }
    removeEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') {
        this._listeners.delete(fn);
      }
    }
    _emitValue(u8) {
      this.value = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const evt = { target: this, currentTarget: this };
      this._listeners.forEach((fn) => {
        try { fn(evt); } catch (e) { console.error(e); }
      });
    }
    writeValueWithoutResponse(bytes) {
      const b64 = u8ToB64(bytes);
      return callAsync((id) => window.AndroidNative.bleWrite(id, b64, false), 8000);
    }
    writeValue(bytes) {
      const b64 = u8ToB64(bytes);
      return callAsync((id) => window.AndroidNative.bleWrite(id, b64, true), 10000);
    }
  }

  class NativeBluetoothService {
    constructor(device) {
      this.device = device;
      this.uuid = MIDI_SERVICE_UUID;
    }
    async getCharacteristic(uuid) {
      activeBleChar = new NativeBluetoothCharacteristic(this);
      return activeBleChar;
    }
  }

  class NativeBluetoothGATTServer {
    constructor(device) {
      this.device = device;
      this.connected = false;
    }
    async connect() {
      await callAsync((id) => window.AndroidNative.bleConnect(id, this.device.id), 25000);
      this.connected = true;
      return this;
    }
    disconnect() {
      this.connected = false;
      try { window.AndroidNative.bleDisconnect(); } catch {}
    }
    async getPrimaryService(uuid) {
      if (!this.connected) throw new Error('GATT Server is disconnected');
      return new NativeBluetoothService(this.device);
    }
  }

  class NativeBluetoothDevice {
    constructor(id, name) {
      this.id = id;
      this.name = name || 'BLE MIDI Device';
      this.gatt = new NativeBluetoothGATTServer(this);
      this._disconnectListeners = new Set();
    }
    addEventListener(type, fn) {
      if (type === 'gattserverdisconnected' && typeof fn === 'function') {
        this._disconnectListeners.add(fn);
      }
    }
    removeEventListener(type, fn) {
      if (type === 'gattserverdisconnected') {
        this._disconnectListeners.delete(fn);
      }
    }
    _emitDisconnected() {
      this.gatt.connected = false;
      const evt = { target: this };
      this._disconnectListeners.forEach((fn) => {
        try { fn(evt); } catch (e) { console.error(e); }
      });
    }
  }

  // Override navigator.bluetooth
  const bluetoothShim = {
    async requestDevice(options) {
      const acceptAll = !!(options && options.acceptAllDevices);
      const res = await callAsync((id) => window.AndroidNative.bleRequestDevice(id, acceptAll), 120000);
      if (activeBleDevice && activeBleDevice.id === res.address) {
        activeBleDevice.name = res.name || activeBleDevice.name;
        return activeBleDevice;
      }
      activeBleDevice = new NativeBluetoothDevice(res.address, res.name);
      return activeBleDevice;
    }
  };
  try {
    Object.defineProperty(navigator, 'bluetooth', {
      value: bluetoothShim,
      configurable: true,
      writable: true
    });
  } catch {
    navigator.bluetooth = bluetoothShim;
  }

  // Override navigator.requestMIDIAccess (Web MIDI over Android Native MidiManager)
  navigator.requestMIDIAccess = async function () {
    const rawJson = await callAsync((id) => window.AndroidNative.midiRequestAccess(id), 15000);
    const list = JSON.parse(rawJson || '[]');
    const inputs = new Map();
    const outputs = new Map();

    list.forEach((dev) => {
      const idStr = String(dev.id);
      const outPort = {
        id: idStr,
        name: dev.name || 'USB MIDI',
        manufacturer: dev.manufacturer || '',
        type: 'output',
        state: 'connected',
        send(bytes) {
          const b64 = u8ToB64(bytes);
          window.AndroidNative.midiSend(dev.id, b64);
        }
      };
      outputs.set(idStr, outPort);

      if (dev.hasInput) {
        let listener = null;
        const inPort = {
          id: idStr,
          name: dev.name || 'USB MIDI',
          manufacturer: dev.manufacturer || '',
          type: 'input',
          state: 'connected',
          get onmidimessage() { return listener; },
          set onmidimessage(fn) {
            listener = fn;
            if (typeof fn === 'function') {
              window.AndroidNative.midiOpenInput(dev.id);
            }
          }
        };
        inputs.set(idStr, inPort);
      }
    });

    activeMidiAccess = {
      inputs,
      outputs,
      sysexEnabled: true,
      onstatechange: null
    };
    return activeMidiAccess;
  };

  // Override screen.orientation.lock / unlock
  if (window.screen) {
    const ori = window.screen.orientation || {};
    ori.lock = async function (mode) {
      window.AndroidNative.setOrientation(String(mode || 'landscape'));
    };
    ori.unlock = function () {
      window.AndroidNative.setOrientation('unspecified');
    };
    try {
      Object.defineProperty(window.screen, 'orientation', { value: ori, configurable: true });
    } catch {}
  }

  // Override navigator.wakeLock
  const wakeLockShim = {
    async request() {
      window.AndroidNative.setKeepScreenOn(true);
      return {
        async release() {
          window.AndroidNative.setKeepScreenOn(false);
        }
      };
    }
  };
  try {
    Object.defineProperty(navigator, 'wakeLock', { value: wakeLockShim, configurable: true });
  } catch {}

  // Intercept <a download="..."> for Blob URLs so downloading .ble works in Android WebView
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  const blobMap = new Map();
  URL.createObjectURL = function (blob) {
    const url = origCreateObjectURL(blob);
    if (blob instanceof Blob) {
      blobMap.set(url, blob);
    }
    return url;
  };

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href && blobMap.has(this.href)) {
      const blob = blobMap.get(this.href);
      const filename = this.download || 'firmware.ble';
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result).split(',')[1] || '';
        window.AndroidNative.saveBase64File(filename, b64);
      };
      reader.readAsDataURL(blob);
      return;
    }
    return origAnchorClick.apply(this, arguments);
  };

  // Global dispatch handler called from Kotlin MainActivity
  window.__nativeBridge = {
    resolve(id, data) {
      const cb = callbacks.get(String(id));
      if (cb) {
        callbacks.delete(String(id));
        cb.resolve(data);
      }
    },
    reject(id, message, name) {
      const cb = callbacks.get(String(id));
      if (cb) {
        callbacks.delete(String(id));
        const err = new Error(message || 'Error');
        if (name) err.name = name;
        cb.reject(err);
      }
    },
    onBleNotify(b64) {
      if (activeBleChar) {
        activeBleChar._emitValue(b64ToU8(b64));
      }
    },
    onBleDisconnected() {
      if (activeBleDevice) {
        activeBleDevice._emitDisconnected();
      }
    },
    onUsbMidiRx(devId, b64) {
      if (!activeMidiAccess) return;
      const inPort = activeMidiAccess.inputs.get(String(devId));
      if (inPort && typeof inPort.onmidimessage === 'function') {
        inPort.onmidimessage({ data: b64ToU8(b64), target: inPort });
      }
    },
    onUsbMidiDisconnected(devId) {
      if (!activeMidiAccess) return;
      const outPort = activeMidiAccess.outputs.get(String(devId));
      if (outPort) {
        outPort.state = 'disconnected';
        if (typeof activeMidiAccess.onstatechange === 'function') {
          activeMidiAccess.onstatechange({ port: outPort });
        }
      }
    }
  };
})();
