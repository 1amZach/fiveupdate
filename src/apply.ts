import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Change } from './plan';
import { writes } from './plan';

// Every update keeps the files it replaced in backups/<id>/files and a record
// in backups/<id>/update.json, written before anything is touched, so it can
// be put back even after a crash halfway through.

export interface Written {
    path: string; // relative to the resource
    had: boolean; // was there a file before
    hash: string | null; // what we wrote, null for a removal
}

export interface Update {
    id: string;
    resource: string;
    repo: string;
    from: string;
    to: string;
    time: number;
    state: 'writing' | 'done' | 'undone';
    files: Written[];
    skipped?: string[]; // files left alone on rollback because they changed after
}

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function read(file: string): Uint8Array | null {
    try {
        return readFileSync(file);
    } catch {
        return null;
    }
}

function write(file: string, data: Uint8Array) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.fiveupdate';
    writeFileSync(tmp, data);
    renameSync(tmp, file);
}

const save = (dir: string, u: Update) => write(join(dir, u.id, 'update.json'), Buffer.from(JSON.stringify(u, null, 2)));

export function apply(dir: string, root: string, info: Omit<Update, 'id' | 'time' | 'state' | 'files'>, changes: Change[]): Update {
    const time = Date.now();
    const u: Update = { ...info, id: `${info.resource}-${info.to}-${time}`, time, state: 'writing', files: [] };
    const todo = writes(changes).map((c) => ({ c, path: c.action === 'conflict' ? c.path + '.new' : c.path }));

    for (const { c, path } of todo) {
        const old = read(join(root, path));
        if (old) write(join(dir, u.id, 'files', path), old);
        u.files.push({ path, had: !!old, hash: c.data ? hash(c.data) : null });
    }
    save(dir, u);

    for (const { c, path } of todo) {
        if (c.data) write(join(root, path), c.data);
        else rmSync(join(root, path), { force: true });
    }
    u.state = 'done';
    save(dir, u);
    return u;
}

export function history(dir: string): Update[] {
    if (!existsSync(dir)) return [];
    const out: Update[] = [];
    for (const id of readdirSync(dir)) {
        const raw = read(join(dir, id, 'update.json'));
        if (!raw) continue;
        try {
            out.push(JSON.parse(Buffer.from(raw).toString()));
        } catch {
            // half-written record from a crash before anything was touched
        }
    }
    return out.sort((a, b) => b.time - a.time);
}

// Puts back what an update replaced. A file that has changed since the update
// is left alone and listed in `skipped`.
export function undo(dir: string, root: string, u: Update): Update {
    const skipped: string[] = [];
    for (const f of [...u.files].reverse()) {
        const now = read(join(root, f.path));
        const nowHash = now ? hash(now) : null;
        const backup = f.had ? read(join(dir, u.id, 'files', f.path)) : null;
        if (nowHash === (backup ? hash(backup) : null)) continue; // never got written
        if (nowHash !== f.hash) {
            skipped.push(f.path);
            continue;
        }
        if (backup) write(join(root, f.path), backup);
        else unlinkSync(join(root, f.path));
    }
    u.state = 'undone';
    u.skipped = skipped;
    save(dir, u);
    return u;
}

// Keep the last few updates of each resource.
export function prune(dir: string, keep: number) {
    const seen = new Map<string, number>();
    for (const u of history(dir)) {
        const n = (seen.get(u.resource) ?? 0) + 1;
        seen.set(u.resource, n);
        if (n > keep && u.state !== 'writing') rmSync(join(dir, u.id), { recursive: true, force: true });
    }
}
