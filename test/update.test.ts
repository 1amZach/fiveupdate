import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { apply, history, prune, undo } from '../src/apply';
import { compare, repoOf } from '../src/github';
import { merge, mergeText, same } from '../src/merge';
import { glob, plan, readZip, safePath, type Files } from '../src/plan';

const u8 = (s: string) => new TextEncoder().encode(s);
const str = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const files = (o: Record<string, string>): Files => new Map(Object.entries(o).map(([k, v]) => [k, u8(v)]));
const reader = (f: Files) => (p: string) => f.get(p) ?? null;

const base = `Config = {}
Config.locale = 'en'
Config.price = 100
Config.debug = false

Config.shops = {
    { name = 'A', coords = vec3(1, 2, 3) },
}
`;

test('versions', () => {
    assert.equal(compare('1.0.3', '1.0.2'), 1);
    assert.equal(compare('v1.10.0', '1.9.9'), 1);
    assert.equal(compare('1.0', '1.0.0'), 0);
    assert.equal(compare('2.0.0-beta.2', '2.0.0'), -1);
    assert.equal(compare('2.0.0-beta.10', '2.0.0-beta.2'), 1);
    assert.equal(compare('1.0.0', '1.2.0'), -1);
});

test('repository lines', () => {
    assert.equal(repoOf('https://github.com/1amZach/warden'), '1amZach/warden');
    assert.equal(repoOf('https://github.com/overextended/ox_lib.git'), 'overextended/ox_lib');
    assert.equal(repoOf('https://github.com/a/b/tree/main'), 'a/b');
    assert.equal(repoOf('git@github.com:a/b.js.git'), 'a/b.js');
    assert.equal(repoOf('https://gitlab.com/a/b'), null);
});

test('line endings and BOM do not count as changes', () => {
    assert.ok(same(u8('a\nb\n'), u8('\uFEFFa\r\nb\r\n')));
    assert.ok(!same(u8('a\nb\n'), u8('a\nc\n')));
});

test('both sides changing different lines merges', () => {
    const ours = base.replace('price = 100', 'price = 250');
    const theirs = base.replace("Config.debug = false\n", "Config.debug = false\nConfig.tax = 0.1\n");
    const m = mergeText(u8(base), u8(ours), u8(theirs));
    assert.ok(m.ok);
    const out = str(m.data)!;
    assert.match(out, /price = 250/);
    assert.match(out, /tax = 0\.1/);
});

test('both sides changing the same line is a conflict', () => {
    const m = mergeText(u8(base), u8(base.replace('100', '250')), u8(base.replace('100', '150')));
    assert.equal(m.ok, false);
});

test('the same change on both sides is fine', () => {
    const both = base.replace("'en'", "'de'");
    const m = mergeText(u8(base), u8(both), u8(both));
    assert.ok(m.ok);
    assert.equal(str(m.data), both);
});

test('a CRLF file keeps CRLF after a merge', () => {
    const ours = base.replace('100', '250').replace(/\n/g, '\r\n');
    const theirs = base.replace("'en'", "'fr'");
    const m = mergeText(u8(base), u8(ours), u8(theirs));
    assert.ok(m.ok);
    assert.equal(str(m.data), base.replace('100', '250').replace("'en'", "'fr'").replace(/\n/g, '\r\n'));
});

test('lines added at the same spot on both sides conflict', () => {
    const ours = base.replace('Config.debug = false\n', 'Config.debug = false\nConfig.a = 1\n');
    const theirs = base.replace('Config.debug = false\n', 'Config.debug = false\nConfig.b = 2\n');
    assert.equal(mergeText(u8(base), u8(ours), u8(theirs)).ok, false);
});

test('a big edit far from the other one merges', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const ours = long.replace('line 10\n', 'line 10 edited\n');
    const theirs = long.replace('line 300\n', 'line 300\nnew line\n').replace('line 390', 'line 390 too');
    const m = mergeText(u8(long), u8(ours), u8(theirs));
    assert.ok(m.ok);
    assert.equal(str(m.data), long.replace('line 10\n', 'line 10 edited\n').replace('line 300\n', 'line 300\nnew line\n').replace('line 390', 'line 390 too'));
});

test('json merges key by key when the lines clash', () => {
    const b = JSON.stringify({ port: 1, list: [1], nested: { a: 1, b: 2 } }, null, 4);
    const o = JSON.stringify({ port: 2, list: [1], nested: { a: 1, b: 2 } }, null, 4);
    const t = JSON.stringify({ port: 1, list: [1], nested: { a: 1, b: 3 }, extra: true }, null, 2);
    const m = merge('config.json', u8(b), u8(o), u8(t));
    assert.ok(m.ok);
    assert.deepEqual(JSON.parse(str(m.data)!), { port: 2, list: [1], nested: { a: 1, b: 3 }, extra: true });
    assert.match(str(m.data)!, /\n {4}"port"/);
    const bad = merge('config.json', u8(b), u8(o), u8(JSON.stringify({ port: 3 })));
    assert.equal(bad.ok, false);
});

test('binary files never merge', () => {
    const bin = (n: number) => new Uint8Array([0, 1, 2, n]);
    assert.equal(merge('stream/a.ytd', bin(1), bin(2), bin(3)).ok, false);
});

test('paths from zips are kept inside the resource', () => {
    assert.equal(safePath('client/main.lua'), 'client/main.lua');
    assert.equal(safePath('a\\b.lua'), 'a/b.lua');
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'C:/x', 'a//b', './a']) assert.equal(safePath(bad), null, bad);
});

test('globs', () => {
    assert.ok(glob('config.lua').test('config.lua'));
    assert.ok(glob('config.lua').test('shared/config.lua'));
    assert.ok(!glob('config.lua').test('myconfig.lua'));
    assert.ok(glob('locales/**').test('locales/en.json'));
    assert.ok(glob('locales/**').test('locales/a/b.lua'));
    assert.ok(!glob('locales/**').test('html/locales.js'));
    assert.ok(glob('*.cfg').test('perms/admin.cfg'));
    assert.ok(glob('html/*.js').test('html/app.js'));
    assert.ok(!glob('html/*.js').test('html/x/app.js'));
});

test('release zips: the resource folder is found, others ignored', () => {
    const zip = zipSync({
        'thing-main-abc123/': new Uint8Array(),
        'thing-main-abc123/fxmanifest.lua': strToU8('fx_version "cerulean"'),
        'thing-main-abc123/client/main.lua': strToU8('print(1)'),
        'thing-main-abc123/test/fxmanifest.lua': strToU8('nested'),
        'README.txt': strToU8('outside'),
    });
    const f = readZip(zip);
    assert.deepEqual([...f.keys()].sort(), ['client/main.lua', 'fxmanifest.lua', 'test/fxmanifest.lua']);
    assert.throws(() => readZip(zipSync({ 'a.txt': strToU8('x') })), /no fxmanifest/);
});

test('plan with the installed release', () => {
    const B = files({
        'fxmanifest.lua': "version '1.0.0'",
        'config.lua': base,
        'client/main.lua': 'print(1)',
        'client/old.lua': 'old',
        'client/gone_edited.lua': 'x',
        'html/app.js': 'a',
        'locales/en.lua': 'hi',
        'deleted_by_me.lua': 'd',
    });
    const O = files({
        'fxmanifest.lua': "version '1.0.0'",
        'config.lua': base.replace('100', '250'),
        'client/main.lua': 'print(1)',
        'client/old.lua': 'old',
        'client/gone_edited.lua': 'x edited',
        'html/app.js': 'a',
        'locales/en.lua': 'hello',
        'mine.lua': 'my own file',
    });
    const T = files({
        'fxmanifest.lua': "version '1.1.0'",
        'config.lua': base.replace("'en'", "'en' -- or 'de'"),
        'client/main.lua': 'print(2)',
        'client/new.lua': 'new',
        'html/app.js': 'a',
        'locales/en.lua': 'hi',
        'deleted_by_me.lua': 'd2',
    });
    const got = Object.fromEntries(plan(reader(O), B, T, []).map((c) => [c.path, c.action]));
    assert.deepEqual(got, {
        'fxmanifest.lua': 'update',
        'config.lua': 'merge',
        'client/main.lua': 'update',
        'client/new.lua': 'add',
        'client/old.lua': 'remove',
        'client/gone_edited.lua': 'keep',
        'locales/en.lua': 'keep',
        'deleted_by_me.lua': 'keep',
    });
    const merged = plan(reader(O), B, T, []).find((c) => c.path === 'config.lua')!;
    assert.match(str(merged.data)!, /price = 250/);
    assert.match(str(merged.data)!, /or 'de'/);
});

test('plan without the installed release keeps config files', () => {
    const O = files({ 'config.lua': 'mine', 'client/main.lua': 'old', 'locales/en.lua': 'mine', 'extra.lua': 'x' });
    const T = files({ 'config.lua': 'theirs', 'client/main.lua': 'new', 'locales/en.lua': 'theirs', 'add.lua': 'a' });
    const got = Object.fromEntries(plan(reader(O), null, T, ['config.lua', 'locales/**']).map((c) => [c.path, c.action]));
    assert.deepEqual(got, { 'add.lua': 'add', 'client/main.lua': 'update', 'config.lua': 'conflict', 'locales/en.lua': 'conflict' });
});

function resource(f: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'fiveupdate-'));
    for (const [p, v] of Object.entries(f)) {
        mkdirSync(join(dir, p, '..'), { recursive: true });
        writeFileSync(join(dir, p), v);
    }
    return dir;
}
const at = (dir: string, p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : undefined);

test('apply, then undo puts every byte back', () => {
    const before = { 'fxmanifest.lua': 'v1', 'config.lua': 'mine', 'client/old.lua': 'old', 'client/main.lua': 'one' };
    const root = resource(before);
    const bk = mkdtempSync(join(tmpdir(), 'fiveupdate-bk-'));
    const changes = [
        { path: 'fxmanifest.lua', action: 'update' as const, data: u8('v2') },
        { path: 'client/main.lua', action: 'merge' as const, data: u8('two') },
        { path: 'client/new/deep.lua', action: 'add' as const, data: u8('new') },
        { path: 'client/old.lua', action: 'remove' as const },
        { path: 'config.lua', action: 'conflict' as const, data: u8('theirs') },
        { path: 'locales/en.lua', action: 'keep' as const },
    ];
    const u = apply(bk, root, { resource: 'thing', repo: 'a/b', from: '1.0.0', to: '1.1.0' }, changes);
    assert.equal(u.state, 'done');
    assert.equal(at(root, 'fxmanifest.lua'), 'v2');
    assert.equal(at(root, 'client/main.lua'), 'two');
    assert.equal(at(root, 'client/new/deep.lua'), 'new');
    assert.equal(at(root, 'client/old.lua'), undefined);
    assert.equal(at(root, 'config.lua'), 'mine');
    assert.equal(at(root, 'config.lua.new'), 'theirs');
    assert.ok(!existsSync(join(root, 'fxmanifest.lua.fiveupdate')));

    const h = history(bk);
    assert.equal(h.length, 1);
    undo(bk, root, h[0]!);
    for (const [p, v] of Object.entries(before)) assert.equal(at(root, p), v, p);
    assert.equal(at(root, 'client/new/deep.lua'), undefined);
    assert.equal(at(root, 'config.lua.new'), undefined);
    assert.equal(history(bk)[0]!.state, 'undone');
});

test('undo leaves files changed after the update alone', () => {
    const root = resource({ 'a.lua': '1', 'b.lua': '1' });
    const bk = mkdtempSync(join(tmpdir(), 'fiveupdate-bk-'));
    const u = apply(bk, root, { resource: 'thing', repo: 'a/b', from: '1', to: '2' }, [
        { path: 'a.lua', action: 'update', data: u8('2') },
        { path: 'b.lua', action: 'update', data: u8('2') },
    ]);
    writeFileSync(join(root, 'b.lua'), 'edited after');
    const done = undo(bk, root, u);
    assert.equal(at(root, 'a.lua'), '1');
    assert.equal(at(root, 'b.lua'), 'edited after');
    assert.deepEqual(done.skipped, ['b.lua']);
});

test('undo after a crash halfway only reverts what got written', () => {
    const root = resource({ 'a.lua': '1', 'b.lua': '1' });
    const bk = mkdtempSync(join(tmpdir(), 'fiveupdate-bk-'));
    const u = apply(bk, root, { resource: 'thing', repo: 'a/b', from: '1', to: '2' }, [
        { path: 'a.lua', action: 'update', data: u8('2') },
        { path: 'b.lua', action: 'update', data: u8('2') },
    ]);
    // pretend b.lua was never reached
    writeFileSync(join(root, 'b.lua'), '1');
    u.state = 'writing';
    const done = undo(bk, root, u);
    assert.equal(at(root, 'a.lua'), '1');
    assert.equal(at(root, 'b.lua'), '1');
    assert.deepEqual(done.skipped, []);
});

test('prune keeps the newest few per resource', () => {
    const root = resource({ 'a.lua': '0' });
    const bk = mkdtempSync(join(tmpdir(), 'fiveupdate-bk-'));
    for (let i = 1; i <= 4; i++) {
        apply(bk, root, { resource: 'thing', repo: 'a/b', from: String(i - 1), to: String(i) }, [{ path: 'a.lua', action: 'update', data: u8(String(i)) }]);
        const t = Date.now();
        while (Date.now() === t);
    }
    apply(bk, root, { resource: 'other', repo: 'a/c', from: '0', to: '1' }, [{ path: 'a.lua', action: 'update', data: u8('x') }]);
    prune(bk, 2);
    const h = history(bk);
    assert.deepEqual(h.filter((u) => u.resource === 'thing').map((u) => u.to), ['4', '3']);
    assert.equal(h.filter((u) => u.resource === 'other').length, 1);
});
