import { DatabaseSync } from 'node:sqlite';
import { hydrateGame } from '../game/engine.js';
import type { Settings } from '../game/types.js';
import type { Game } from '../game/types.js';
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS games (session TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS requests (session TEXT NOT NULL, request_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(session,request_id)); CREATE TABLE IF NOT EXISTS settings (session TEXT PRIMARY KEY, speed TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)');
    const columns=this.db.prepare('PRAGMA table_info(settings)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='revision'))this.db.exec('ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  load(session: string): Game | null {
    const row=this.db.prepare('SELECT state FROM games WHERE session=?').get(session) as {state:string}|undefined;
    return row ? hydrateGame(JSON.parse(row.state) as Game) : null;
  }
  settings(session: string): Settings {
    const row=this.db.prepare('SELECT speed,revision FROM settings WHERE session=?').get(session) as Settings|undefined;
    return {speed:row?.speed??'normal',revision:row?.revision??0};
  }
  saveSettings(session: string, settings: Pick<Settings,'speed'>, requestId: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO settings(session,speed,revision) VALUES(?,?,1) ON CONFLICT(session) DO UPDATE SET speed=excluded.speed,revision=settings.revision+1').run(session,settings.speed);
      this.recordRequest(session,requestId);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private recordRequest(session: string, requestId: string) {
    this.db.prepare('INSERT OR IGNORE INTO requests(session,request_id,created) VALUES(?,?,?)').run(session,requestId,Date.now());
    this.db.prepare('DELETE FROM requests WHERE session=? AND rowid NOT IN (SELECT rowid FROM requests WHERE session=? ORDER BY rowid DESC LIMIT 100)').run(session,session);
  }
  hasRequest(session: string, requestId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM requests WHERE session=? AND request_id=?').get(session,requestId);
  }
  save(session: string, game: Game, requestId?: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO games(session,state,updated) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(session,JSON.stringify(game),Date.now());
      if(requestId)this.recordRequest(session,requestId);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close() { this.db.close(); }
}
