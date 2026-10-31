// The FiveM server natives and globals this resource uses.

declare function on(event: string, handler: (...args: any[]) => void): void;
declare function emit(event: string, ...args: unknown[]): void;

declare function GetCurrentResourceName(): string;
declare function GetConvar(name: string, fallback: string): string;
declare function ExecuteCommand(command: string): void;
declare function RegisterCommand(name: string, handler: (src: number, args: string[], raw: string) => void, restricted: boolean): void;

declare function GetNumResources(): number;
declare function GetResourceByFindIndex(index: number): string;
declare function GetResourceState(name: string): string;
declare function GetResourceMetadata(name: string, key: string, index: number): string;
declare function GetResourcePath(name: string): string;
declare function LoadResourceFile(name: string, path: string): string | null;
