export interface Release {
    repo: string;
    tag: string;
    version: string;
    notes: string;
    url: string;
    zip: string; // download link for the resource zip
}

let token = '';
export const setToken = (t: string) => (token = t);

// "https://github.com/owner/name", with or without .git, a trailing slash or
// a path after it.
export function repoOf(url: string): string | null {
    const m = url.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
    return m ? `${m[1]}/${m[2]}` : null;
}

export const versionOf = (tag: string) => tag.trim().replace(/^v(?=\d)/i, '');

// 1 if a is newer, -1 if older, 0 if the same. Numbers are compared as numbers,
// and a release without a -beta style suffix beats one with it.
export function compare(a: string, b: string): number {
    const [ma = '', pa = ''] = versionOf(a).split('-', 2);
    const [mb = '', pb = ''] = versionOf(b).split('-', 2);
    const x = ma.split('.'), y = mb.split('.');
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const p = Number(x[i] ?? 0), q = Number(y[i] ?? 0);
        if (Number.isNaN(p) || Number.isNaN(q)) {
            const s = (x[i] ?? '').localeCompare(y[i] ?? '');
            if (s) return Math.sign(s);
        } else if (p !== q) return p > q ? 1 : -1;
    }
    if (pa === pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    return Math.sign(pa.localeCompare(pb, undefined, { numeric: true }));
}

async function api(path: string): Promise<any> {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'fiveupdate',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const wait = reset ? ` until ${new Date(reset).toLocaleTimeString()}` : '';
        throw new Error(`GitHub rate limit hit${wait}. Set fiveupdate_github_token to get more.`);
    }
    if (!res.ok) throw new Error(`GitHub said ${res.status} for ${path}`);
    return res.json();
}

// The zip to install from: one named after the resource or repo, or the only
// zip attached, or else GitHub's source zip.
function pick(r: any, names: string[]): string {
    const zips = (r.assets ?? []).filter((a: any) => /\.zip$/i.test(a.name));
    const named = zips.find((a: any) => names.some((n) => a.name.toLowerCase() === `${n.toLowerCase()}.zip`));
    return (named ?? (zips.length === 1 ? zips[0] : null))?.browser_download_url ?? r.zipball_url;
}

function release(repo: string, r: any, resource: string): Release {
    return {
        repo,
        tag: r.tag_name,
        version: versionOf(r.tag_name),
        notes: (r.body ?? '').trim(),
        url: r.html_url,
        zip: pick(r, [resource, repo.split('/')[1]!]),
    };
}

export async function latest(repo: string, resource: string): Promise<Release | null> {
    const r = await api(`/repos/${repo}/releases/latest`);
    return r ? release(repo, r, resource) : null;
}

// The release a version was installed from, tagged "v1.2.3" or "1.2.3".
export async function find(repo: string, resource: string, version: string): Promise<Release | null> {
    for (const tag of [`v${versionOf(version)}`, versionOf(version)]) {
        const r = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
        if (r) return release(repo, r, resource);
    }
    return null;
}

const cache = new Map<string, Uint8Array>();

export async function download(url: string): Promise<Uint8Array> {
    const hit = cache.get(url);
    if (hit) return hit;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'fiveupdate', ...(token && url.startsWith('https://api.github.com') ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`download failed with ${res.status}: ${url}`);
    const size = Number(res.headers.get('content-length'));
    if (size > 200 * 1024 * 1024) throw new Error(`${url} is over 200 MB`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (cache.size >= 4) cache.clear();
    cache.set(url, data);
    return data;
}
