import { unzipSync } from 'fflate';
import { merge, same } from './merge';

export type Files = Map<string, Uint8Array>;

export type Action =
    | 'update' // changed in the release, not here: take the new one
    | 'add' // new in the release
    | 'remove' // dropped from the release, not changed here
    | 'merge' // changed on both sides, merged
    | 'keep' // changed here only, or here and dropped from the release
    | 'conflict'; // changed on both sides in the same places: yours stays, the new one goes next to it

export interface Change {
    path: string;
    action: Action;
    data?: Uint8Array; // what gets written to path, or to path + '.new' for a conflict
    note?: string;
}

// Only plain relative paths, so nothing in a zip can write outside the resource.
export function safePath(p: string): string | null {
    const clean = p.replace(/\\/g, '/');
    if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean)) return null;
    const parts = clean.split('/');
    if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
    return clean;
}

// The files of the resource in a release zip. Release zips usually hold one
// folder named after the resource; GitHub's source zips hold owner-repo-sha/.
// The resource is wherever the shallowest fxmanifest.lua is.
export function readZip(zip: Uint8Array): Files {
    const all = unzipSync(zip);
    const manifests = Object.keys(all)
        .filter((p) => /(^|\/)(fxmanifest|__resource)\.lua$/.test(p))
        .sort((a, b) => a.split('/').length - b.split('/').length);
    if (!manifests[0]) throw new Error('no fxmanifest.lua in the zip');
    const root = manifests[0].slice(0, manifests[0].lastIndexOf('/') + 1);

    const files: Files = new Map();
    for (const [name, data] of Object.entries(all)) {
        if (!name.startsWith(root) || name.endsWith('/')) continue;
        const path = safePath(name.slice(root.length));
        if (path) files.set(path, data);
    }
    return files;
}

// Glob with * (one segment) and ** (any depth). A pattern without a slash
// matches the file name anywhere.
export function glob(pattern: string): RegExp {
    const p = pattern.includes('/') ? pattern : '**/' + pattern;
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i]!;
        if (c === '*' && p[i + 1] === '*') {
            if (p[i + 2] === '/') re += '(?:.*/)?', (i += 2);
            else re += '.*', i++;
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
    return new RegExp('^' + re + '$');
}

export function plan(ours: (path: string) => Uint8Array | null, base: Files | null, theirs: Files, keep: string[]): Change[] {
    const keepers = keep.map(glob);
    const kept = (p: string) => keepers.some((re) => re.test(p));
    const changes: Change[] = [];
    const paths = [...new Set([...theirs.keys(), ...(base?.keys() ?? [])])].sort();

    for (const path of paths) {
        const o = ours(path), t = theirs.get(path) ?? null;
        const b = base ? (base.get(path) ?? null) : undefined;

        if (o && t && same(o, t)) continue;

        if (b === undefined) {
            // No copy of the installed release, so there's no telling who changed
            // what. Config files are kept, everything else is replaced.
            if (!t) continue;
            if (!o) changes.push({ path, action: 'add', data: t });
            else if (kept(path)) changes.push({ path, action: 'conflict', data: t, note: 'config file, yours kept' });
            else changes.push({ path, action: 'update', data: t });
            continue;
        }

        if (!t) {
            // gone from the new release
            if (!o) continue;
            if (b && same(o, b)) changes.push({ path, action: 'remove' });
            else if (b) changes.push({ path, action: 'keep', note: 'removed from the release, but changed here' });
            continue;
        }
        if (!o) {
            if (!b) changes.push({ path, action: 'add', data: t });
            else if (!same(b, t)) changes.push({ path, action: 'keep', note: 'deleted here, left out' });
            continue;
        }
        if (!b) {
            // here and in the new release, but not in the old one
            changes.push({ path, action: 'conflict', data: t, note: 'added on both sides' });
            continue;
        }
        if (same(o, b)) {
            changes.push({ path, action: 'update', data: t });
            continue;
        }
        if (same(t, b)) {
            changes.push({ path, action: 'keep', note: 'changed here, not in the release' });
            continue;
        }
        const m = merge(path, b, o, t);
        if (m.ok) changes.push({ path, action: 'merge', data: m.data, note: 'your changes and the release\'s combined' });
        else changes.push({ path, action: 'conflict', data: t, note: m.conflicts > 1 ? `${m.conflicts} places changed on both sides` : 'changed on both sides in the same place' });
    }
    return changes;
}

// Only what touches the disk.
export const writes = (changes: Change[]) => changes.filter((c) => c.action !== 'keep');
