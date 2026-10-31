import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, history, prune, undo, type Update } from './apply';
import { load, self } from './config';
import { compare, download, find, latest, repoOf, setToken, type Release } from './github';
import { plan, readZip, writes, type Change } from './plan';

const config = load();
setToken(GetConvar('fiveupdate_github_token', ''));
const backups = join(GetResourcePath(self), 'backups');
const seenFile = join(GetResourcePath(self), 'seen.json');

interface Tracked {
    name: string;
    repo: string;
    version: string;
    path: string;
    latest?: Release | null;
    error?: string;
}

interface Prepared {
    resource: string;
    repo: string;
    from: string;
    to: string;
    release: Release;
    exact: boolean; // the installed release was found, so changes are told apart properly
    changes: Change[];
    at: number;
}

const tracked = new Map<string, Tracked>();
const pending = new Map<string, Prepared>();
let busy = false;

function scan() {
    const found = new Map<string, Tracked>();
    for (let i = 0; i < GetNumResources(); i++) {
        const name = GetResourceByFindIndex(i);
        if (!name || config.ignore.includes(name) || GetResourceState(name) === 'missing') continue;
        const repo = config.resources[name] ?? repoOf(GetResourceMetadata(name, 'repository', 0) ?? '');
        const version = GetResourceMetadata(name, 'version', 0);
        if (!repo || !version) continue;
        found.set(name, { name, repo, version, path: GetResourcePath(name), latest: tracked.get(name)?.latest });
    }
    tracked.clear();
    for (const [k, v] of found) tracked.set(k, v);
}

const outdated = () => [...tracked.values()].filter((t) => t.latest && compare(t.latest.version, t.version) > 0);

async function check(): Promise<Tracked[]> {
    scan();
    for (const t of tracked.values()) {
        try {
            t.latest = await latest(t.repo, t.name);
            t.error = t.latest ? undefined : 'no releases';
        } catch (err) {
            t.error = (err as Error).message;
            if (/rate limit/.test(t.error)) break;
        }
    }
    return outdated();
}

// --- telling people ---------------------------------------------------------

function seen(): Record<string, string> {
    try {
        return JSON.parse(readFileSync(seenFile, 'utf8'));
    } catch {
        return {};
    }
}

async function announce(list: Tracked[]) {
    const before = seen();
    const fresh = list.filter((t) => before[t.name] !== t.latest!.version);
    if (!fresh.length) return;
    for (const t of fresh) before[t.name] = t.latest!.version;
    writeFileSync(seenFile, JSON.stringify(before, null, 2));

    const lines = fresh.map((t) => `**${t.name}** ${t.version} → [${t.latest!.version}](${t.latest!.url})`);
    const title = fresh.length === 1 ? 'Update available' : `${fresh.length} updates available`;
    const text = lines.join('\n') + '\n\nRun `fiveupdate update <name>` in the server console.';

    if (GetResourceState('fivecord') === 'started') {
        try {
            return (globalThis as any).exports.fivecord.log(config.discordKind, title, text, 0x5865f2);
        } catch {
            // fall through to the webhook
        }
    }
    const hook = GetConvar('fiveupdate_webhook', '');
    if (!hook) return;
    await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'fiveupdate', embeds: [{ title, description: text, color: 0x5865f2 }] }),
    }).catch((err) => console.warn(`fiveupdate: webhook failed: ${err.message}`));
}

// --- updating ---------------------------------------------------------------

function readOurs(root: string) {
    return (path: string) => {
        try {
            return readFileSync(join(root, path));
        } catch {
            return null;
        }
    };
}

async function prepare(name: string): Promise<Prepared> {
    scan();
    const t = tracked.get(name);
    if (!t) throw new Error(`${name} isn't tracked. It needs a version and a GitHub repository in its fxmanifest, or an entry in config.json.`);
    const release = await latest(t.repo, t.name);
    if (!release) throw new Error(`${t.repo} has no releases`);
    t.latest = release;
    if (compare(release.version, t.version) <= 0) throw new Error(`${name} is up to date (${t.version})`);

    const old = await find(t.repo, t.name, t.version);
    const base = old ? readZip(await download(old.zip)) : null;
    const theirs = readZip(await download(release.zip));
    const changes = plan(readOurs(t.path), base, theirs, config.keep);
    return { resource: name, repo: t.repo, from: t.version, to: release.version, release, exact: !!base, changes, at: Date.now() };
}

function commit(p: Prepared): Update {
    const t = tracked.get(p.resource)!;
    const u = apply(backups, t.path, { resource: p.resource, repo: p.repo, from: p.from, to: p.to }, p.changes);
    prune(backups, config.backups);
    ExecuteCommand('refresh');
    if (config.restart && p.resource !== self && GetResourceState(p.resource) === 'started') ExecuteCommand(`ensure ${p.resource}`);
    return u;
}

// --- console ----------------------------------------------------------------

const say = (s = '') => console.log(s);
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));

const colors: Record<string, string> = { update: '^2', add: '^2', remove: '^1', merge: '^5', keep: '^7', conflict: '^3' };

function show(p: Prepared) {
    say(`^5${p.resource}^7 ${p.from} -> ^2${p.to}^7  ${p.release.url}`);
    if (p.release.notes) for (const l of p.release.notes.split(/\r?\n/).slice(0, 8)) say(`  ^9${l}^7`);
    if (!p.exact) say(`  ^3Release ${p.from} isn't on GitHub, so your changes can't be told apart from the update's. Files matching "keep" in config.json stay as they are, everything else is replaced.^7`);
    say();
    const w = Math.max(...p.changes.map((c) => c.path.length), 10) + 2;
    for (const c of p.changes) say(`  ${colors[c.action]}${pad(c.action, 9)}^7${pad(c.path, w)}${c.note ?? ''}`);
    const conflicts = p.changes.filter((c) => c.action === 'conflict');
    if (conflicts.length) say(`\n  ^3For each conflict your file stays, and the new one is written next to it as <file>.new to compare by hand.^7`);
    say();
}

function list() {
    if (!tracked.size) return say('fiveupdate: no resources with a GitHub repository found');
    const w = Math.max(...[...tracked.keys()].map((n) => n.length)) + 2;
    for (const t of [...tracked.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const state = t.error ? `^1${t.error}^7`
            : !t.latest ? '^9not checked^7'
            : compare(t.latest.version, t.version) > 0 ? `^3${t.latest.version} available^7`
            : '^2up to date^7';
        say(`  ${pad(t.name, w)}${pad(t.version, 10)}${state}`);
    }
}

async function run(args: string[]) {
    const [cmd = 'list', name, flag] = args;

    if (cmd === 'list') {
        scan();
        return list();
    }
    if (cmd === 'check') {
        const out = await check();
        list();
        void announce(out);
        return;
    }
    if (cmd === 'update' && name) {
        const names = name === 'all' ? (scan(), (await check()).map((t) => t.name)) : [name];
        if (!names.length) return say('fiveupdate: everything is up to date');
        let shown = 0;
        for (const n of names) {
            const ready = pending.get(n);
            if (flag === 'confirm' && ready && Date.now() - ready.at < 10 * 60e3) {
                pending.delete(n);
                if (!writes(ready.changes).length) {
                    say(`fiveupdate: ${n} has nothing to write`);
                    continue;
                }
                const u = commit(ready);
                say(`fiveupdate: ^2${n} updated to ${u.to}^7. Backup in backups/${u.id}, "fiveupdate undo ${n}" puts it back.`);
                if (!config.restart || n === self) say(`fiveupdate: restart ${n} to load it`);
                continue;
            }
            try {
                const p = await prepare(n);
                pending.set(n, p);
                show(p);
                shown++;
            } catch (err) {
                say(`fiveupdate: ${(err as Error).message}`);
            }
        }
        if (shown) say(`Run "fiveupdate update ${name} confirm" to write it. The files it replaces are backed up first.`);
        return;
    }
    if (cmd === 'undo' && name) {
        const u = history(backups).find((h) => h.resource === name && h.state !== 'undone');
        if (!u) return say(`fiveupdate: no update of ${name} to undo`);
        const t = tracked.get(name) ?? (scan(), tracked.get(name));
        const done = undo(backups, t?.path ?? GetResourcePath(name), u);
        say(`fiveupdate: ${name} put back to ${u.from}`);
        for (const s of done.skipped ?? []) say(`  ^3left alone, changed since the update: ${s}^7`);
        ExecuteCommand('refresh');
        return;
    }
    if (cmd === 'history') {
        const h = history(backups).filter((u) => !name || u.resource === name);
        if (!h.length) return say('fiveupdate: no updates yet');
        for (const u of h.slice(0, 20)) say(`  ${new Date(u.time).toLocaleString()}  ${pad(u.resource, 16)}${u.from} -> ${u.to}  ${u.state === 'done' ? '' : u.state}`);
        return;
    }
    say('fiveupdate list | check | update <name|all> [confirm] | undo <name> | history [name]');
}

// console and rcon only, it writes files on the server
RegisterCommand('fiveupdate', (src, args) => {
    if (src !== 0) return;
    if (busy) return say('fiveupdate: still busy with the last command');
    busy = true;
    run(args)
        .catch((err) => say(`fiveupdate: ${(err as Error).message}`))
        .finally(() => (busy = false));
}, true);

// An update that crashed halfway is easy to miss, so say so on every start.
for (const u of history(backups)) {
    if (u.state === 'writing') console.warn(`fiveupdate: the update of ${u.resource} to ${u.to} didn't finish. Run "fiveupdate undo ${u.resource}" to put it back.`);
}

async function tick() {
    try {
        const out = await check();
        if (out.length) {
            say(`fiveupdate: ^3${out.map((t) => `${t.name} ${t.version} -> ${t.latest!.version}`).join(', ')}^7. Run "fiveupdate update <name>" to see what changes.`);
            await announce(out);
        }
    } catch (err) {
        console.warn(`fiveupdate: check failed: ${(err as Error).message}`);
    }
    if (config.checkHours > 0) setTimeout(tick, config.checkHours * 3600e3);
}
setTimeout(tick, 15e3);

// For other resources, like a web panel. All but list return promises.
const ex = (globalThis as any).exports;
ex('list', () => {
    scan();
    return [...tracked.values()].map((t) => ({ name: t.name, repo: t.repo, version: t.version, latest: t.latest?.version ?? null, error: t.error ?? null }));
});
ex('check', async () => (await check()).map((t) => ({ name: t.name, version: t.version, latest: t.latest!.version })));
ex('preview', async (name: string) => {
    const p = await prepare(name);
    pending.set(name, p);
    return { from: p.from, to: p.to, exact: p.exact, notes: p.release.notes, files: p.changes.map(({ path, action, note }) => ({ path, action, note })) };
});
ex('update', async (name: string) => {
    const ready = pending.get(name);
    const p = ready && Date.now() - ready.at < 10 * 60e3 ? ready : await prepare(name);
    pending.delete(name);
    return commit(p);
});
ex('history', () => history(backups));
ex('undo', (name: string) => {
    const u = history(backups).find((h) => h.resource === name && h.state !== 'undone');
    return u ? undo(backups, GetResourcePath(name), u) : null;
});
