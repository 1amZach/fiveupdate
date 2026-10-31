// Three-way merges. `base` is the release that was installed, `ours` is what's
// on disk now and `theirs` is the new release.

export const isText = (b: Uint8Array) => !b.subarray(0, 8000).includes(0);

const decoder = new TextDecoder();
const text = (b: Uint8Array) => decoder.decode(b).replace(/^﻿/, '').replace(/\r\n/g, '\n');

// Same file, ignoring line endings and a BOM so a checkout with CRLF doesn't
// count as edited.
export function same(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length === b.length && a.every((x, i) => x === b[i])) return true;
    return isText(a) && isText(b) && text(a) === text(b);
}

// For each line of a, the line of b it lines up with, or -1. Longest common
// subsequence after cutting off the shared start and end. null when the middle
// is too big to do in reasonable memory.
function match(a: string[], b: string[]): Int32Array | null {
    const out = new Int32Array(a.length).fill(-1);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) out[start] = start++;
    let ea = a.length, eb = b.length;
    while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) out[--ea] = --eb;

    const n = ea - start, m = eb - start;
    if (n === 0 || m === 0) return out;
    if (n * m > 4_000_000) return null;

    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            t[i * w + j] = a[start + i] === b[start + j]
                ? t[(i + 1) * w + j + 1]! + 1
                : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
        }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[start + i] === b[start + j]) out[start + i++] = start + j++;
        else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
        else j++;
    }
    return out;
}

const eqLines = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export type Merged = { ok: true; data: Uint8Array } | { ok: false; conflicts: number };

export function mergeText(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Merged {
    const crlf = decoder.decode(ours.subarray(0, 4000)).includes('\r\n');
    const B = text(base).split('\n'), O = text(ours).split('\n'), T = text(theirs).split('\n');
    const mo = match(B, O), mt = match(B, T);
    if (!mo || !mt) return { ok: false, conflicts: 1 };

    const out: string[] = [];
    let conflicts = 0;
    let b = 0, o = 0, t = 0;
    const settle = (b2: number, o2: number, t2: number) => {
        const rb = B.slice(b, b2), ro = O.slice(o, o2), rt = T.slice(t, t2);
        if (eqLines(ro, rb)) out.push(...rt);
        else if (eqLines(rt, rb) || eqLines(ro, rt)) out.push(...ro);
        else if (rb.length === ro.length && rb.length === rt.length) {
            // Both only edited lines in place, like options next to each other
            // in a config. Fine as long as no single line was edited by both.
            for (let i = 0; i < rb.length; i++) {
                if (ro[i] === rb[i]) out.push(rt[i]!);
                else if (rt[i] === rb[i] || rt[i] === ro[i]) out.push(ro[i]!);
                else conflicts++, out.push(ro[i]!);
            }
        } else {
            conflicts++;
            out.push(...ro);
        }
    };
    // walk the base lines both sides kept, and settle what's between them
    for (let k = 0; k < B.length; k++) {
        const ko = mo[k]!, kt = mt[k]!;
        if (ko < 0 || kt < 0) continue;
        settle(k, ko, kt);
        out.push(B[k]!);
        b = k + 1, o = ko + 1, t = kt + 1;
    }
    settle(B.length, O.length, T.length);

    if (conflicts) return { ok: false, conflicts };
    return { ok: true, data: new TextEncoder().encode(out.join(crlf ? '\r\n' : '\n')) };
}

// JSON settings files, key by key, for when the lines don't merge because one
// side reformatted or moved things around.
const CONFLICT = Symbol('conflict');

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const deq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeValue(b: unknown, o: unknown, t: unknown): unknown {
    if (deq(o, t) || deq(t, b)) return o;
    if (deq(o, b)) return t;
    if (!plain(b) || !plain(o) || !plain(t)) return CONFLICT;
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
        const v = mergeValue(b[k], o[k], t[k]);
        if (v === CONFLICT) return CONFLICT;
        if (v !== undefined) out[k] = v;
    }
    return out;
}

export function mergeJson(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Merged {
    let b, o, t;
    try {
        [b, o, t] = [base, ours, theirs].map((x) => JSON.parse(text(x)));
    } catch {
        return { ok: false, conflicts: 1 };
    }
    const v = mergeValue(b, o, t);
    if (v === CONFLICT) return { ok: false, conflicts: 1 };
    const raw = text(ours);
    const indent = raw.match(/\n([ \t]+)\S/)?.[1] ?? '    ';
    return { ok: true, data: new TextEncoder().encode(JSON.stringify(v, null, indent) + (raw.endsWith('\n') ? '\n' : '')) };
}

export function merge(path: string, base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Merged {
    if (!isText(base) || !isText(ours) || !isText(theirs)) return { ok: false, conflicts: 1 };
    const lines = mergeText(base, ours, theirs);
    if (lines.ok || !path.endsWith('.json')) return lines;
    const keys = mergeJson(base, ours, theirs);
    return keys.ok ? keys : lines;
}
