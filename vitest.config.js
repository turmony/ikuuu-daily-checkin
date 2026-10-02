import {cloudflareTest} from '@cloudflare/vitest-plugin';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{
    ADMIN_TOKEN:'test-admin-token-with-at-least-32-characters',
    COOKIE_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }}})],
  test:{include:['test/runtime/**/*.test.js'],fileParallelism:false},
});
