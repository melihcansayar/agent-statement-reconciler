// Append-only audit trail: what was read, what each pass decided and why, every AI call.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export class Audit {
  readonly runId = randomUUID();
  readonly events: Record<string, unknown>[] = [];
  constructor(private file?: string) { if (file) mkdirSync(dirname(file), { recursive: true }); }
  log(event: string, data: Record<string, unknown> = {}) {
    const e = { ts: new Date().toISOString(), run: this.runId, event, ...data };
    this.events.push(e);
    if (this.file) appendFileSync(this.file, JSON.stringify(e) + '\n');
  }
  input(path: string) {
    const buf = readFileSync(path);
    this.log('input', { path, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
    return buf.toString('utf8');
  }
}
