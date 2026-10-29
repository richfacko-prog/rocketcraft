// Racecraft Worker: static game files + multiplayer API.
import { Lobby } from './lobby';
import { Room } from './room';
import type { Env } from './env';

export { Lobby, Room };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const roomWs = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/ws$/);
    if (roomWs) {
      const stub = env.ROOM.get(env.ROOM.idFromName(roomWs[1]));
      return stub.fetch(req);
    }
    if (url.pathname.startsWith('/api/')) {
      const stub = env.LOBBY.get(env.LOBBY.idFromName('global'));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
