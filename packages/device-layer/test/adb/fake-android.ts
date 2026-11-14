import type { FakeDevice, FakeDeviceStream, ServiceHandler } from './fake-device.ts';

/**
 * 서비스 계층 테스트용 가짜 Android. 실제 adbd의 서비스 프로토콜(shell v2, sync, exec:cmd,
 * root:, tcp:)을 FakeDeviceStream 위에서 흉내 내고, 상태(파일/패키지/root)를 메모리에 둔다.
 */
export class FakeAndroid {
  readonly files = new Map<string, { data: Buffer; mode: number; mtimeSec: number }>();
  readonly packages = new Set<string>();
  readonly shellCommands: string[] = [];
  readonly installs: Array<{ size: number; options: string[] }> = [];
  isRoot = false;
  /** 설정하면 input 명령이 이 메시지로 실패한다(종료 코드 1). */
  failInput: string | undefined;
  /** `dumpsys input_method` 이 보고할 화면 키보드 표시 여부(undefined 면 그 줄이 없는 기기) */
  keyboardShown: boolean | undefined = false;
  /** `settings put/get --user 0 secure` 저장소. */
  readonly secureSettings = new Map<string, string>();
  /** true 면 settings put 이 조용히 무시된다(Secure Folder 기기에서 --user 0 을 빠뜨린 상황 흉내). */
  /** 처음 N 번의 `enabled_accessibility_services` put 을 무시한다(막 설치한 서비스를 접근성 관리자가 목록에서 지우는 실기기 동작 흉내). */
  ignoreFirstAccessibilityPuts = 0;
  ignoreSettingsPut = false;
  /** install 이 성공하면 이 패키지가 설치된 것으로 기록한다. */
  installPackageName = 'com.example.app';
  /** 설정하면 install 이 이 사유로 실패한다. */
  failInstall: string | undefined;
  /** 온디바이스 헬퍼(접근성 서비스) 흉내. 설치(packages)·활성화(secureSettings)·토큰이 갖춰져야 tcp:38300 이 응답한다. */
  readonly helper = {
    pkg: 'io.sinclair.helper',
    service: 'io.sinclair.helper/io.sinclair.helper.SinclairAccessibilityService',
    port: 38300,
    token: undefined as string | undefined,
    /** true 면 SET_TOKEN 브로드캐스트를 무시한다(토큰 불일치 상황). */
    dropToken: false,
    version: '0.1.0',
    /** /ping 의 sdk. 30 미만이면 /snapshot 이 스크린샷 없이 돌아온다(takeScreenshot 미지원). */
    sdk: 33,
    /** true 면 takeScreenshot 이 간격 제한(ERROR 3)으로 실패한 상황: 트리만 돌려준다. */
    screenshotRateLimited: false,
    /** POST /action 으로 받은 제스처·입력 기록(`tap 10,20` 등). */
    gestures: [] as string[],
    /** true 면 dispatchGesture 가 취소된 상황(다른 접근성 서비스가 가로채는 등): 409 를 돌려준다. */
    refuseGestures: false,
    /** 포커스된 입력 필드의 내용. type 액션이 뒤에 덧붙인다. null 이면 포커스된 필드가 없다. */
    focusedText: '' as string | null,
    tree: { ref: '@e0', role: 'group', rect: { x: 0, y: 0, width: 1080, height: 2400 }, children: [{ ref: '@e1', role: 'button', name: '로그인', rect: { x: 10, y: 20, width: 100, height: 40 } }] } as unknown,
    requests: [] as string[],
  };
  /** screencap -p 가 돌려줄 PNG. 시그니처 + 멀티바이트 안전성 확인용 0x80 이상 바이트를 포함한다. */
  screenshotPng: Buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80])]);
  /** getprop 응답. */
  readonly props = new Map<string, string>([['ro.product.model', 'Fake Pixel'], ['ro.build.version.release', '14']]);
  /** root: 응답. "restarting"으로 시작하면 root 상태로 바꾸고 onAdbdRestart를 호출. */
  rootResponse = 'adbd cannot run as root in production builds\n';
  onAdbdRestart: () => void = () => {};
  /** true 면 root: 응답을 보내기 전에 재시작한다(연결이 응답보다 먼저 끊기는 기기·부하 상황) */
  restartBeforeRootResponse = false;
  /** true면 pm이 APK를 끝까지 읽기 전에 거부하고 스트림을 닫는다. */
  rejectInstallEarly = false;
  private sessions = new Map<string, Buffer[]>();
  /**
   * 연결(FakeDevice)별 reverse 규칙(remote → local). 실제 adbd처럼 연결이 끊기면 규칙도 사라진다
   * (새 연결은 새 FakeDevice이므로 빈 규칙으로 시작).
   */
  readonly reverses = new Map<FakeDevice, Map<string, string>>();
  /** tcp:0 요청 시 할당할 기기 포트. */
  nextDevicePort = 40000;
  /** 설정하면 이 remote에 대한 reverse를 FAIL로 거부(포트 사용 중 흉내). */
  busyRemote: string | undefined;

  readonly services: ServiceHandler = (destination) => {
    if (destination.startsWith('shell,v2,raw:')) {
      const command = destination.slice('shell,v2,raw:'.length);
      return (s) => void this.shell(s, command);
    }
    if (destination === 'sync:') return (s) => void this.sync(s);
    if (destination.startsWith('exec:cmd package ')) {
      const args = destination.slice('exec:cmd package '.length).split(' ');
      return (s) => void this.cmdPackage(s, args);
    }
    if (destination === 'root:') return (s) => void this.root(s);
    if (destination.startsWith('reverse:')) {
      return (s) => void this.reverse(s, destination.slice('reverse:'.length));
    }
    const tcp = /^tcp:(\d+)$/.exec(destination);
    if (tcp && Number(tcp[1]) === this.helper.port) {
      // 접근성 서비스가 켜져 있을 때만 서버가 떠 있다. 아니면 연결 거부(CLSE).
      return this.helperServing() ? (s) => void this.helperHttp(s) : undefined;
    }
    if (tcp) return (s) => void this.upperEcho(s);
    return undefined;
  };

  // ---- shell v2 ----

  private async shell(s: FakeDeviceStream, command: string): Promise<void> {
    this.shellCommands.push(command);
    if (command === '') return this.interactive(s);
    const { stdout = '', stderr = '', exit = 0 } = this.run(command);
    if (stdout) await sendShell(s, 1, stdout);
    if (stderr) await sendShell(s, 2, stderr);
    await sendShell(s, 3, Buffer.from([exit]));
    s.close();
  }

  /** 대화형: stdin 패킷을 줄 단위로 실행, "exit"면 종료. */
  private async interactive(s: FakeDeviceStream): Promise<void> {
    for (;;) {
      const header = await s.readBytes(5);
      if (!header) return;
      const id = header.readUInt8(0);
      const payload = (await s.readBytes(header.readUInt32LE(1))) ?? Buffer.alloc(0);
      if (id === 3) break;
      for (const line of payload.toString('utf-8').split('\n').filter(Boolean)) {
        if (line === 'exit') {
          await sendShell(s, 3, Buffer.from([0]));
          s.close();
          return;
        }
        const { stdout = '' } = this.run(line);
        if (stdout) await sendShell(s, 1, stdout);
      }
    }
    await sendShell(s, 3, Buffer.from([0]));
    s.close();
  }

  private run(command: string): { stdout?: string | Buffer; stderr?: string; exit?: number } {
    let m: RegExpExecArray | null;
    if ((m = /^echo (.*)$/.exec(command))) return { stdout: `${m[1]}\n` };
    if (command === 'dumpsys input_method') return { stdout: `  mServedView=x\n${this.keyboardShown === undefined ? '' : `  mInputShown=${this.keyboardShown}\n`}  mShowRequested=false\n` };
    if (command.startsWith('input ')) return this.failInput ? { stderr: `${this.failInput}\n`, exit: 1 } : {};
    if ((m = /^monkey -p '([^']+)' -c android\.intent\.category\.LAUNCHER 1$/.exec(command))) {
      if (this.packages.has(m[1]!)) return { stdout: 'Events injected: 1\n' };
      return { stderr: `** No activities found to run, monkey aborted.\n`, exit: 252 };
    }
    if (/^am force-stop '[^']+'$/.test(command)) return {};
    if ((m = /^am start -W -a android\.intent\.action\.VIEW -d '([^']+)'$/.exec(command))) {
      // 실제 am 은 처리할 액티비티가 없어도 종료 코드 0 으로 "Error: ..." 만 출력한다.
      if (m[1]!.startsWith('nothing://')) return { stdout: 'Starting: Intent { act=android.intent.action.VIEW }\nError: Activity not started, unable to resolve Intent\n' };
      return { stdout: 'Starting: Intent { act=android.intent.action.VIEW }\nStatus: ok\n' };
    }
    if (command === 'screencap -p') return this.failInput ? { stderr: `${this.failInput}\n`, exit: 1 } : { stdout: this.screenshotPng };
    if ((m = /^fail (\d+) (.*)$/.exec(command))) return { stderr: `${m[2]}\n`, exit: Number(m[1]) };
    if ((m = /^(?:cmd package|pm) uninstall (\S+)$/.exec(command))) {
      if (this.packages.delete(m[1]!)) return { stdout: 'Success\n' };
      return { stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n', exit: 1 };
    }
    if ((m = /^pm install .*"(.+)"$/.exec(command))) {
      const file = this.files.get(m[1]!);
      if (file?.data.subarray(0, 2).toString() === 'PK') {
        this.packages.add('com.example.app');
        return { stdout: 'Success\n' };
      }
      return { stdout: 'Failure [INSTALL_FAILED_INVALID_APK]\n', exit: 1 };
    }
    if (command.startsWith('rm -f ')) {
      for (const p of command.slice(6).match(/"[^"]+"/g) ?? []) this.files.delete(p.slice(1, -1));
      return {};
    }
    if (command === 'getprop service.adb.root') return { stdout: this.isRoot ? '1\n' : '\n' };
    if ((m = /^getprop (\S+)$/.exec(command))) return { stdout: `${this.props.get(m[1]!) ?? ''}\n` };
    if ((m = /^pm path '([^']+)'$/.exec(command))) {
      return this.packages.has(m[1]!) ? { stdout: `package:/data/app/${m[1]}/base.apk\n` } : { exit: 1 };
    }
    if ((m = /^settings get --user 0 secure (\S+)$/.exec(command))) return { stdout: `${this.secureSettings.get(m[1]!) ?? 'null'}\n` };
    if ((m = /^settings put --user 0 secure (\S+) '?([^']*)'?$/.exec(command))) {
      if (m[1] === 'enabled_accessibility_services' && this.ignoreFirstAccessibilityPuts > 0) { this.ignoreFirstAccessibilityPuts--; return {}; }
      if (!this.ignoreSettingsPut) this.secureSettings.set(m[1]!, m[2]!);
      return {};
    }
    if ((m = /^am broadcast -a io\.sinclair\.helper\.SET_TOKEN -n \S+ --es token '([^']*)'$/.exec(command))) {
      if (!this.helper.dropToken) this.helper.token = m[1] || undefined;
      return { stdout: 'Broadcast completed: result=0\n' };
    }
    return { stderr: `sh: ${command}: not found\n`, exit: 127 };
  }

  // ---- sync ----

  private async sync(s: FakeDeviceStream): Promise<void> {
    for (;;) {
      const header = await s.readBytes(8);
      if (!header) return;
      const id = header.toString('ascii', 0, 4);
      const arg = header.readUInt32LE(4);
      if (id === 'QUIT') {
        s.close();
        return;
      }
      const text = ((await s.readBytes(arg)) ?? Buffer.alloc(0)).toString('utf-8');
      if (id === 'SEND') await this.syncSend(s, text);
      else if (id === 'RECV') await this.syncRecv(s, text);
    }
  }

  private async syncSend(s: FakeDeviceStream, spec: string): Promise<void> {
    const comma = spec.lastIndexOf(',');
    const path = spec.slice(0, comma);
    const mode = Number(spec.slice(comma + 1));
    const parts: Buffer[] = [];
    for (;;) {
      const header = (await s.readBytes(8))!;
      const id = header.toString('ascii', 0, 4);
      const arg = header.readUInt32LE(4);
      if (id === 'DATA') {
        if (arg > 64 * 1024) throw new Error(`DATA too large: ${arg}`);
        parts.push((await s.readBytes(arg))!);
      } else if (id === 'DONE') {
        if (path.startsWith('/readonly/')) return sendSync(s, 'FAIL', 'Permission denied');
        this.files.set(path, { data: Buffer.concat(parts), mode, mtimeSec: arg });
        return sendSync(s, 'OKAY');
      }
    }
  }

  private async syncRecv(s: FakeDeviceStream, path: string): Promise<void> {
    const file = this.files.get(path);
    if (!file) return sendSync(s, 'FAIL', 'No such file or directory');
    for (let offset = 0; offset < file.data.length; offset += 64 * 1024) {
      await sendSync(s, 'DATA', file.data.subarray(offset, offset + 64 * 1024));
    }
    await sendSync(s, 'DONE');
  }

  // ---- exec:cmd package ----

  private async cmdPackage(s: FakeDeviceStream, args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const reply = async (text: string): Promise<void> => {
      await s.send(text);
      s.close();
    };
    if (verb === 'install') {
      const size = Number(rest[1]);
      this.installs.push({ size, options: rest.slice(2) });
      if (this.rejectInstallEarly) {
        await s.readBytes(4);
        return reply('Failure [INSTALL_FAILED_INVALID_APK: early]\n');
      }
      const apk = (await s.readBytes(size)) ?? Buffer.alloc(0);
      if (apk.subarray(0, 2).toString() !== 'PK') return reply('Failure [INSTALL_FAILED_INVALID_APK]\n');
      if (this.failInstall) return reply(`Failure [${this.failInstall}]\n`);
      this.packages.add(this.installPackageName);
      return reply('Success\n');
    }
    if (verb === 'install-create') {
      const id = String(1000 + this.sessions.size);
      this.sessions.set(id, []);
      return reply(`Success: created install session [${id}]\n`);
    }
    if (verb === 'install-write') {
      const [, size, session] = rest as [string, string, string];
      const data = (await s.readBytes(Number(size)))!;
      this.sessions.get(session)?.push(data);
      return reply(`Success: streamed ${size} bytes\n`);
    }
    if (verb === 'install-commit') {
      const parts = this.sessions.get(rest[0]!) ?? [];
      if (parts.every((p) => p.subarray(0, 2).toString() === 'PK')) {
        this.packages.add(`com.example.split:${parts.length}`);
        return reply('Success\n');
      }
      return reply('Failure [INSTALL_FAILED_INVALID_APK]\n');
    }
    if (verb === 'install-abandon') return reply('Success\n');
    return reply(`Unknown command: ${verb}\n`);
  }

  // ---- reverse: ----

  /** 기기 앱이 reverse 포트에 접속하는 상황 흉내: 해당 규칙의 local로 호스트에 OPEN을 보낸다. */
  connectReverse(devicePort: number): Promise<FakeDeviceStream | null> {
    const entries = [...this.reverses.entries()];
    for (let i = entries.length - 1; i >= 0; i--) {
      const [device, rules] = entries[i]!;
      const local = rules.get(`tcp:${devicePort}`);
      if (local) return device.openFromDevice(local);
    }
    throw new Error(`기기 포트 ${devicePort}에 reverse 규칙이 없습니다.`);
  }

  /** 현재(가장 최근 연결) 규칙들. */
  currentReverses(): Map<string, string> {
    const all = [...this.reverses.values()];
    return all[all.length - 1] ?? new Map();
  }

  private async reverse(s: FakeDeviceStream, command: string): Promise<void> {
    let rules = this.reverses.get(s.device);
    if (!rules) this.reverses.set(s.device, (rules = new Map()));
    const reply = async (body: string): Promise<void> => {
      if (body) await s.send(body);
      s.close();
    };
    const protocolString = (v: string): string => v.length.toString(16).padStart(4, '0') + v;

    let m: RegExpExecArray | null;
    if ((m = /^forward(:norebind)?:(tcp:\d+);(.+)$/.exec(command))) {
      let remote = m[2]!;
      if (remote === this.busyRemote) return reply(`FAIL${protocolString('cannot bind listener: Address already in use')}`);
      if (m[1] && rules.has(remote)) return reply(`FAIL${protocolString('cannot rebind existing socket')}`);
      let port = '';
      if (remote === 'tcp:0') {
        port = String(this.nextDevicePort++);
        remote = `tcp:${port}`;
      }
      rules.set(remote, m[3]!);
      return reply(`OKAY${port ? protocolString(port) : ''}`);
    }
    if ((m = /^killforward:(.+)$/.exec(command))) {
      if (!rules.delete(m[1]!)) return reply(`FAIL${protocolString(`listener '${m[1]}' not found`)}`);
      return reply('OKAY');
    }
    if (command === 'killforward-all') {
      rules.clear();
      return reply('OKAY');
    }
    if (command === 'list-forward') {
      const lines = [...rules].map(([remote, local]) => `host-19 ${remote} ${local}\n`).join('');
      return reply(protocolString(lines));
    }
    return reply(`FAIL${protocolString('not a reverse forwarding command')}`);
  }

  // ---- root: / tcp: ----

  private async root(s: FakeDeviceStream): Promise<void> {
    if (this.restartBeforeRootResponse) { this.isRoot = true; this.onAdbdRestart(); return; }
    await s.send(this.rootResponse);
    s.close();
    if (this.rootResponse.startsWith('restarting')) {
      this.isRoot = true;
      this.onAdbdRestart();
    }
  }

  /** 기기 쪽 TCP 서버 흉내: 받은 데이터를 대문자로 돌려준다. */
  helperServing(): boolean {
    return this.packages.has(this.helper.pkg) && (this.secureSettings.get('enabled_accessibility_services') ?? '').includes(this.helper.service)
      && this.secureSettings.get('accessibility_enabled') === '1';
  }

  /** 실제 헬퍼 HelperServer 와 같은 계약의 최소 HTTP: Bearer 토큰, /ping, /dump, 연결마다 닫음. */
  private async helperHttp(s: FakeDeviceStream): Promise<void> {
    let raw = '';
    while (!raw.endsWith('\r\n\r\n') && raw.length < 16384) {
      const b = await s.readBytes(1);
      if (!b) return;
      raw += b.toString('latin1');
    }
    const [requestLine = '', ...headers] = raw.split('\r\n');
    const contentLength = Number(headers.find((h) => h.toLowerCase().startsWith('content-length:'))?.split(':')[1]?.trim() ?? 0);
    const body = contentLength > 0 ? (await s.readBytes(contentLength))?.toString('utf8') ?? '' : '';
    const [method = '', pathWithQuery = '/'] = requestLine.split(' ');
    const path = pathWithQuery.split('?')[0]!;
    this.helper.requests.push(`${method} ${path}`);
    const auth = headers.find((h) => h.toLowerCase().startsWith('authorization:'))?.split(':').slice(1).join(':').trim();
    const respond = async (status: number, body: unknown) => {
      const json = Buffer.from(JSON.stringify(body), 'utf8');
      await s.send(`HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: ${json.length}\r\nConnection: close\r\n\r\n`);
      await s.send(json);
      s.close();
    };
    if (!this.helper.token || auth !== `Bearer ${this.helper.token}`) return respond(401, { error: this.helper.token ? '토큰 불일치' : '세션 토큰이 설정되지 않음' });
    if (method === 'POST' && path === '/action') {
      const a = JSON.parse(body) as Record<string, unknown>;
      const line = a['action'] === 'tap' ? `tap ${a['x']},${a['y']}`
        : a['action'] === 'long_press' ? `longpress ${a['x']},${a['y']} ${a['durationMs']}`
        : a['action'] === 'swipe' ? `swipe ${a['fromX']},${a['fromY']}->${a['toX']},${a['toY']} ${a['durationMs']}`
        : a['action'] === 'type' ? `type ${a['text']}` : undefined;
      if (!line) return respond(400, { error: `action 본문 오류: 알 수 없는 action: ${a['action']}` }); // 실제 헬퍼와 같은 400
      if (a['action'] === 'type') {
        if (this.helper.focusedText === null) return respond(409, { ok: false, detail: '포커스된 입력 필드가 없음' });
        this.helper.focusedText += String(a['text']);
        this.helper.gestures.push(line);
        return respond(200, { ok: true, via: 'set_text' });
      }
      if (this.helper.refuseGestures) return respond(409, { ok: false, detail: '제스처가 취소됨(dispatchGesture cancelled)' });
      this.helper.gestures.push(line);
      return respond(200, { ok: true, via: 'gesture' });
    }
    if (method !== 'GET') return respond(405, { error: 'GET/POST 만 지원' });
    if (path === '/ping') return respond(200, { ok: true, version: this.helper.version, sdk: this.helper.sdk, service: 'ready' });
    if (path === '/dump') return respond(200, this.helper.tree);
    if (path === '/snapshot') {
      if (this.helper.sdk < 30) return respond(200, { root: this.helper.tree, atomic: false, detail: 'takeScreenshot 은 Android 11(API 30) 이상에서만 지원' });
      if (this.helper.screenshotRateLimited) return respond(200, { root: this.helper.tree, atomic: false, detail: 'takeScreenshot 호출 간격 제한(errorCode 3), 재시도 실패' });
      return respond(200, { root: this.helper.tree, atomic: true, screenshot: { format: 'png', base64: this.screenshotPng.toString('base64') } });
    }
    return respond(404, { error: `알 수 없는 경로: ${path}` });
  }

  private async upperEcho(s: FakeDeviceStream): Promise<void> {
    for (;;) {
      const chunk = await s.readBytes(1);
      if (!chunk) return;
      await s.send(chunk.toString().toUpperCase());
    }
  }
}

function sendShell(s: FakeDeviceStream, id: number, payload: string | Buffer): Promise<void> {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  const header = Buffer.alloc(5);
  header.writeUInt8(id, 0);
  header.writeUInt32LE(body.length, 1);
  return s.send(Buffer.concat([header, body]));
}

function sendSync(s: FakeDeviceStream, id: string, payload: string | Buffer = Buffer.alloc(0)): Promise<void> {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32LE(id === 'DONE' || id === 'OKAY' ? 0 : body.length, 4);
  return s.send(id === 'DONE' || id === 'OKAY' ? header : Buffer.concat([header, body]));
}
