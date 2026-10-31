export const self = GetCurrentResourceName();

export interface Config {
    checkHours: number;
    keep: string[]; // files treated as yours when the installed release can't be found
    ignore: string[];
    resources: Record<string, string>; // name -> owner/repo, for resources without a repository line
    restart: boolean;
    backups: number;
    discordKind: string;
}

const defaults: Config = {
    checkHours: 6,
    keep: ['config.lua', 'config.json', 'config/**', 'locales/**', 'locale/**', '*.cfg'],
    ignore: [],
    resources: {},
    restart: false,
    backups: 5,
    discordKind: 'resources',
};

export function load(): Config {
    const raw = LoadResourceFile(self, 'config.json');
    if (!raw) return defaults;
    try {
        return { ...defaults, ...JSON.parse(raw) };
    } catch (err) {
        console.error(`fiveupdate: config.json is not valid JSON (${(err as Error).message}), using defaults`);
        return defaults;
    }
}
