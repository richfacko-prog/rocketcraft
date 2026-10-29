// Online menu: profile, quick play, private rooms, teams, leaderboard and the room lobby.
// Every name shown here comes from other players, so it is always set with textContent.
import { Api, ApiError, Socket, type TeamInfo } from '../net/api';
import type { BotSlot, LobbyServerMsg, NetMode, RoomInfo, RosterPlayer } from '../net/protocol';
import type { OnlineSetup } from '../game/Match';
import type { Difficulty } from '../game/AI';
import type { CarDesign } from '../game/CarDesign';

const BOT_NAMES = ['Merlin', 'Viper', 'Sundown', 'Rainmaker', 'Beast', 'Casper'];
const $ = (id: string) => document.getElementById(id)!;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  const { cls, ...rest } = props as { cls?: string };
  if (cls) e.className = cls;
  Object.assign(e, rest);
  for (const k of kids) e.append(k);
  return e;
}

export class OnlineMenu {
  api = new Api();
  private lobby: Socket | null = null;
  private room: Socket | null = null;
  private roomInfo: RoomInfo | null = null;
  private team: TeamInfo | null = null;
  private teamQueued = false;
  private queueMode: NetMode | 'team' | null = null;
  private queueSince = 0;
  private queueWaiting = 0;
  private tab: 'play' | 'teams' | 'board' = 'play';
  private botDifficulty: Difficulty = 'pro';
  private roomJoinedAt = 0;
  private starting = false;
  open = false;

  constructor(
    private getDesign: () => CarDesign,
    private onStart: (setup: OnlineSetup) => void,
    private onBack: () => void,
  ) {
    $('on-back').addEventListener('click', () => {
      this.leaveRoom();
      this.hide();
      this.onBack();
    });
    for (const b of document.querySelectorAll<HTMLElement>('#online .on-tab')) {
      b.addEventListener('click', () => this.setTab(b.dataset.tab as 'play' | 'teams' | 'board'));
    }
    $('on-name-save').addEventListener('click', () => void this.saveName());
    ($('on-name') as HTMLInputElement).addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.saveName();
    });
    $('on-q1').addEventListener('click', () => this.queue('1v1'));
    $('on-q2').addEventListener('click', () => this.queue('2v2'));
    $('on-qcancel').addEventListener('click', () => this.cancelQueue());
    $('on-create1').addEventListener('click', () => void this.createRoom('1v1'));
    $('on-create2').addEventListener('click', () => void this.createRoom('2v2'));
    const code = $('on-code') as HTMLInputElement;
    code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.joinRoom(code.value.trim().toUpperCase());
    });
    $('on-join').addEventListener('click', () => void this.joinRoom(code.value.trim().toUpperCase()));
  }

  // ------------------------------------------------------------------ open / close
  async show() {
    this.open = true;
    $('online').classList.remove('hidden');
    this.setTab(this.tab);
    this.status('Connecting…');
    try {
      const me = await this.api.ensure();
      ($('on-name') as HTMLInputElement).value = me.name;
      const info = await this.api.me();
      this.team = info.team;
      ($('on-name') as HTMLInputElement).value = info.player.name;
      this.renderProfile(info.player);
      this.connectLobby();
      this.status('');
      this.render();
    } catch (e) {
      this.status((e as Error).message, true);
    }
  }

  hide() {
    this.open = false;
    $('online').classList.add('hidden');
  }

  /** Back from a finished online match. */
  returnFromMatch() {
    this.room?.close();
    this.room = null;
    this.roomInfo = null;
    this.starting = false;
    void this.show();
  }

  private status(text: string, error = false) {
    const s = $('on-status');
    s.textContent = text;
    s.classList.toggle('err', error);
  }

  private setTab(tab: 'play' | 'teams' | 'board') {
    this.tab = tab;
    for (const b of document.querySelectorAll<HTMLElement>('#online .on-tab')) b.classList.toggle('sel', b.dataset.tab === tab);
    for (const p of document.querySelectorAll<HTMLElement>('#online [data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== tab || !!this.room);
    if (tab === 'board') void this.loadBoard();
    this.render();
  }

  // ------------------------------------------------------------------ lobby socket
  private connectLobby() {
    if (this.lobby?.open) return;
    const id = this.api.identity!;
    const sock = new Socket(`${this.api.wsBase()}/api/lobby?id=${id.id}&token=${id.token}`);
    this.lobby = sock;
    sock.onMessage = (m) => this.onLobby(m as LobbyServerMsg);
    sock.onClose = () => {
      if (this.lobby !== sock) return;
      this.lobby = null;
      this.queueMode = null;
      if (this.open && !sock.closedByUs) setTimeout(() => this.open && this.connectLobby(), 2000);
    };
    sock.connect();
  }

  private onLobby(m: LobbyServerMsg) {
    switch (m.t) {
      case 'queue':
        this.queueMode = m.mode;
        this.queueWaiting = m.waiting;
        this.queueSince = m.since;
        break;
      case 'matched':
        this.queueMode = null;
        this.teamQueued = false;
        void this.joinRoom(m.code);
        break;
      case 'team':
        if (this.team) this.team.members = m.members;
        this.teamQueued = m.queued;
        break;
      case 'error':
        this.status(m.message, true);
        break;
    }
    this.render();
  }

  private queue(mode: NetMode) {
    if (!this.lobby?.open) return this.status('Still connecting to the server…', true);
    this.lobby.send({ t: 'queue', mode });
    this.queueMode = mode;
    this.queueSince = Date.now();
    this.status('');
    this.render();
  }

  private cancelQueue() {
    this.lobby?.send({ t: this.queueMode === 'team' ? 'teamCancel' : 'cancel' });
    this.queueMode = null;
    this.render();
  }

  private async saveName() {
    const input = $('on-name') as HTMLInputElement;
    try {
      const name = await this.api.rename(input.value);
      input.value = name;
      this.status('Name saved.');
    } catch (e) {
      this.status((e as Error).message, true);
    }
  }

  // ------------------------------------------------------------------ rooms
  private async createRoom(mode: NetMode) {
    try {
      const { code } = await this.api.createRoom(mode);
      await this.joinRoom(code);
    } catch (e) {
      this.status((e as Error).message, true);
    }
  }

  private async joinRoom(code: string) {
    if (!/^[A-Z0-9]{5}$/.test(code)) return this.status('Room codes are 5 letters or numbers.', true);
    this.leaveRoom();
    if (this.queueMode) this.cancelQueue();
    const id = this.api.identity!;
    const sock = new Socket(`${this.api.wsBase()}/api/room/${code}/ws?id=${id.id}&token=${id.token}`);
    this.room = sock;
    this.roomJoinedAt = performance.now();
    this.starting = false;
    let opened = false;
    sock.onOpen = () => {
      opened = true;
      sock.send({ t: 'hello', design: this.getDesign() });
    };
    sock.onMessage = (m) => this.onRoom(m as Record<string, unknown>);
    sock.onClose = (code) => {
      if (this.room !== sock) return;
      this.room = null;
      this.roomInfo = null;
      if (!sock.closedByUs) this.status(opened ? `Disconnected from the room (${code}).` : 'Couldn’t join that room. Check the code, or it may be full or already playing.', true);
      this.setTab(this.tab);
    };
    sock.connect();
    this.status(`Joining room ${code}…`);
    this.setTab(this.tab);
  }

  private leaveRoom() {
    if (this.room) {
      this.room.close();
      this.room = null;
      this.roomInfo = null;
    }
  }

  private onRoom(m: Record<string, unknown>) {
    if (m.t === 'roster') {
      this.roomInfo = m as unknown as RoomInfo;
      this.status('');
      this.render();
      return;
    }
    const d = (m.d ?? null) as Record<string, unknown> | null;
    if (d?.t === 'start' && this.roomInfo && m.f === this.roomInfo.hostId) this.launch(d.bots as BotSlot[], (d.difficulty as Difficulty) ?? 'pro', d.mode === '2v2' ? '2v2' : '1v1');
  }

  /** Called every frame while the online menu is open (auto-start for matched rooms). */
  tick() {
    if (!this.room || !this.roomInfo || this.starting) return;
    const info = this.roomInfo;
    if (info.kind === 'private' || info.hostId !== this.api.identity?.id) return;
    const per = info.mode === '1v1' ? 1 : 2;
    void per;
    const waited = (performance.now() - this.roomJoinedAt) / 1000;
    const full = info.players.length >= (info.expected ?? 99);
    if (full || waited > 12) this.hostStart();
  }

  private hostStart() {
    const info = this.roomInfo;
    if (!info || !this.room || this.starting) return;
    const per = info.mode === '1v1' ? 1 : 2;
    const bots: BotSlot[] = [];
    let n = 0;
    for (const team of [0, 1] as const) {
      const have = info.players.filter((p) => p.team === team).length;
      for (let i = have; i < per; i++) bots.push({ id: `bot-${n}`, name: BOT_NAMES[n++ % BOT_NAMES.length], team });
    }
    this.room.send({ t: 'start', bots, difficulty: this.botDifficulty, mode: info.mode });
    this.launch(bots, this.botDifficulty, info.mode);
  }

  private launch(bots: BotSlot[], difficulty: Difficulty, mode: NetMode) {
    const info = this.roomInfo;
    const room = this.room;
    if (!info || !room || this.starting) return;
    this.starting = true;
    room.onMessage = null; // the match drains messages itself from now on
    room.onClose = (code) => {
      if (this.room === room) this.room = null;
      if (!room.closedByUs) this.onDisconnect?.(`Lost connection to the match (${code}).`);
    };
    this.hide();
    this.onStart({
      room,
      selfId: this.api.identity!.id,
      hostId: info.hostId,
      roster: info.players as RosterPlayer[],
      bots,
      mode,
      difficulty,
    });
  }

  /** Set by main: called if the room connection drops mid-match. */
  onDisconnect: ((reason: string) => void) | null = null;

  // ------------------------------------------------------------------ teams / leaderboard data
  private async loadBoard() {
    const box = $('on-board');
    box.replaceChildren(h('p', { cls: 'on-muted', textContent: 'Loading the leaderboard…' }));
    try {
      const lb = await this.api.leaderboard();
      const me = this.api.identity?.id;
      const players = h('table', { cls: 'on-table' });
      const ph = players.insertRow();
      for (const t of ['#', 'PLAYER', 'MMR', 'W–L', 'GOALS', 'SAVES']) ph.appendChild(h('th', { textContent: t }));
      lb.players.forEach((p, i) => {
        const r = players.insertRow();
        if (p.id === me) r.className = 'me';
        for (const v of [i + 1, p.name, p.mmr, `${p.wins}–${p.losses}`, p.goals, p.saves]) r.insertCell().textContent = String(v);
      });
      if (!lb.players.length) players.insertRow().insertCell().textContent = 'No ranked games yet. Play an online match to get on the board.';
      const teams = h('table', { cls: 'on-table' });
      const th = teams.insertRow();
      for (const t of ['#', 'TEAM', 'RATING', 'W–L', 'PLAYERS']) th.appendChild(h('th', { textContent: t }));
      lb.teams.forEach((t, i) => {
        const r = teams.insertRow();
        if (t.id === this.team?.id) r.className = 'me';
        for (const v of [i + 1, t.name, t.rating, `${t.wins}–${t.losses}`, t.members]) r.insertCell().textContent = String(v);
      });
      if (!lb.teams.length) teams.insertRow().insertCell().textContent = 'No teams yet.';
      box.replaceChildren(
        h('div', { cls: 'on-cols' }, h('div', { cls: 'on-col' }, h('h3', { textContent: 'TOP PLAYERS' }), h('div', { cls: 'on-scroll' }, players)), h('div', { cls: 'on-col' }, h('h3', { textContent: 'TOP TEAMS' }), h('div', { cls: 'on-scroll' }, teams))),
        h('p', { cls: 'on-muted', textContent: 'Only online matches count. MMR starts at 1000 and moves with every win or loss.' }),
      );
    } catch (e) {
      box.replaceChildren(h('p', { cls: 'on-err', textContent: (e as Error).message }));
    }
  }

  private renderProfile(p: { mmr: number; wins: number; losses: number; games: number }) {
    $('on-rank').textContent = p.games ? `MMR ${p.mmr} · ${p.wins}–${p.losses}` : 'Unranked';
  }

  // ------------------------------------------------------------------ rendering
  private render() {
    if (!this.open) return;
    // play tab
    const q = this.queueMode;
    $('on-qstate').textContent =
      q && q !== 'team'
        ? `Searching for a ${q} match (${Math.max(0, Math.round((Date.now() - this.queueSince) / 1000))}s)… ${this.queueWaiting} in queue.${q === '2v2' ? ' Bots fill empty seats after 20 seconds.' : ''}`
        : 'Find players at your level, or start a private room and share its code with friends.';
    $('on-qcancel').classList.toggle('hidden', !q || q === 'team');
    for (const id of ['on-q1', 'on-q2']) ($(id) as HTMLButtonElement).disabled = !!q;
    this.renderTeams();
    this.renderRoom();
  }

  private renderTeams() {
    const box = $('on-teams');
    const t = this.team;
    if (!t) {
      const name = h('input', { id: 'on-team-name', maxLength: 20, placeholder: 'Team name' });
      const code = h('input', { id: 'on-team-code', maxLength: 6, placeholder: 'Team code' });
      for (const i of [name, code]) i.addEventListener('keydown', (e) => e.stopPropagation());
      box.replaceChildren(
        h('div', { cls: 'on-cols' },
          h('div', { cls: 'on-col' },
            h('h3', { textContent: 'CREATE A TEAM' }),
            h('p', { cls: 'on-muted', textContent: 'You get a code to share. Up to 3 players per team; 2 play in each team battle.' }),
            h('div', { cls: 'on-row' }, name, h('button', { cls: 'g-btn primary', type: 'button', textContent: 'Create', onclick: () => void this.teamAction(() => this.api.createTeam(name.value)) })),
          ),
          h('div', { cls: 'on-col' },
            h('h3', { textContent: 'JOIN A TEAM' }),
            h('p', { cls: 'on-muted', textContent: 'Ask your teammate for their team code.' }),
            h('div', { cls: 'on-row' }, code, h('button', { cls: 'g-btn primary', type: 'button', textContent: 'Join', onclick: () => void this.teamAction(() => this.api.joinTeam(code.value)) })),
          ),
        ),
      );
      return;
    }
    const online = t.members.filter((m) => m.online).length;
    const list = h('ul', { cls: 'on-members' });
    for (const m of t.members) {
      const li = h('li', {}, h('span', { cls: `dot ${m.online ? 'on' : ''}` }), m.name + (m.id === t.captain ? ' (captain)' : ''));
      list.appendChild(li);
    }
    const find = h('button', {
      cls: 'play',
      type: 'button',
      textContent: this.teamQueued ? 'SEARCHING FOR A TEAM…' : 'FIND TEAM BATTLE (2v2)',
      disabled: online < 2 && !this.teamQueued,
      onclick: () => {
        if (this.teamQueued) this.lobby?.send({ t: 'teamCancel' });
        else this.lobby?.send({ t: 'teamQueue' });
      },
    });
    box.replaceChildren(
      h('div', { cls: 'on-team-head' }, h('div', {}, h('div', { cls: 'on-team-name', textContent: t.name }), h('div', { cls: 'on-muted', textContent: `Rating ${t.rating} · ${t.wins}–${t.losses}` })), h('div', { cls: 'on-code' }, h('small', { textContent: 'TEAM CODE' }), h('strong', { textContent: t.code }))),
      list,
      find,
      h('p', { cls: 'on-muted', textContent: this.teamQueued ? 'Click again to stop searching.' : online < 2 ? 'Both teammates need this Teams tab open to search for a battle.' : 'Your team will face another team in a 2v2. Results change your team rating.' }),
      h('button', { cls: 'secondary', type: 'button', textContent: 'Leave team', onclick: () => void this.teamAction(() => this.api.leaveTeam()) }),
    );
  }

  private async teamAction(fn: () => Promise<unknown>) {
    try {
      await fn();
      const info = await this.api.me();
      this.team = info.team;
      // the lobby socket caches our team: reconnect so presence/queueing use the new one
      this.lobby?.close();
      this.lobby = null;
      this.connectLobby();
      this.status('');
      this.render();
    } catch (e) {
      this.status((e as ApiError).message, true);
    }
  }

  private renderRoom() {
    const box = $('on-room');
    box.classList.toggle('hidden', !this.room);
    for (const p of document.querySelectorAll<HTMLElement>('#online [data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== this.tab || !!this.room);
    $('on-tabs').classList.toggle('hidden', !!this.room);
    if (!this.room) return;
    const info = this.roomInfo;
    if (!info) {
      box.replaceChildren(h('p', { cls: 'on-muted', textContent: 'Joining…' }));
      return;
    }
    const me = this.api.identity!.id;
    const isHost = info.hostId === me;
    const per = info.mode === '1v1' ? 1 : 2;
    const column = (team: 0 | 1) => {
      const ps = info.players.filter((p) => p.team === team);
      const ul = h('ul', { cls: 'on-slots' });
      for (const p of ps) ul.appendChild(h('li', { cls: p.id === me ? 'me' : '' }, p.name + (p.id === info.hostId ? ' ★' : '')));
      for (let i = ps.length; i < per; i++) ul.appendChild(h('li', { cls: 'empty', textContent: info.kind === 'private' ? 'Open (bot if empty)' : 'Waiting…' }));
      const title = info.teamNames?.[team] ?? (team === 0 ? 'BLUE' : 'ORANGE');
      const col = h('div', { cls: `on-side t${team}` }, h('h3', { textContent: title }), ul);
      const mine = info.players.find((p) => p.id === me);
      if (info.kind === 'private' && mine && mine.team !== team && ps.length < per)
        col.appendChild(h('button', { cls: 'g-btn', type: 'button', textContent: `Join ${team === 0 ? 'Blue' : 'Orange'}`, onclick: () => this.room?.send({ t: 'setTeam', team }) }));
      return col;
    };
    const kids: (Node | string)[] = [
      h('div', { cls: 'on-room-head' },
        h('div', {}, h('div', { cls: 'on-muted', textContent: info.kind === 'private' ? 'PRIVATE ROOM · share this code' : info.kind === 'team' ? 'TEAM BATTLE' : 'QUICK PLAY' }), h('div', { cls: 'on-room-code', textContent: info.code })),
        h('div', { cls: 'on-muted', textContent: `${info.mode} · ${info.players.length} player${info.players.length === 1 ? '' : 's'}` }),
      ),
      h('div', { cls: 'on-sides' }, column(0), column(1)),
    ];
    if (info.kind === 'private') {
      if (isHost) {
        const modeRow = h('div', { cls: 'seg' });
        for (const m of ['1v1', '2v2'] as const) modeRow.appendChild(h('button', { type: 'button', cls: info.mode === m ? 'sel' : '', textContent: m, onclick: () => this.room?.send({ t: 'setMode', mode: m }) }));
        const diffRow = h('div', { cls: 'seg' });
        for (const [d, label] of [['rookie', 'Rookie'], ['pro', 'Pro'], ['allstar', 'All-Star']] as const)
          diffRow.appendChild(h('button', { type: 'button', cls: this.botDifficulty === d ? 'sel' : '', textContent: label, onclick: () => ((this.botDifficulty = d), this.render()) }));
        kids.push(
          h('div', { cls: 'row' }, h('div', { cls: 'label', textContent: 'MODE' }), modeRow),
          h('div', { cls: 'row' }, h('div', { cls: 'label', textContent: 'BOTS' }), diffRow),
          h('button', { cls: 'play', type: 'button', textContent: 'START MATCH', onclick: () => this.hostStart() }),
        );
      } else kids.push(h('p', { cls: 'on-muted', textContent: 'Waiting for the host to start the match…' }));
    } else {
      kids.push(h('p', { cls: 'on-muted', textContent: isHost ? 'Starting as soon as everyone is in…' : 'Waiting for the match to start…' }));
    }
    kids.push(h('button', { cls: 'secondary', type: 'button', textContent: 'Leave room', onclick: () => (this.leaveRoom(), this.setTab(this.tab)) }));
    box.replaceChildren(...kids);
  }
}
