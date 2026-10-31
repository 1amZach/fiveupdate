import * as esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/server.js',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    legalComments: 'external',
});
