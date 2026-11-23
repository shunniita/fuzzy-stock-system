import { normalize } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default mergeConfig(base, {
  plugins: [{
    name: 'mutator-native-paths',
    configResolved(config) {
      if (process.platform !== 'win32') return;
      const plugin = config.plugins.find(plugin => plugin.name === 'mutator:instrument');
      if (!plugin) return;
      // shortcut: mutator 0.3.0のWindowsパス照合を補うため、上流の修正後に削除する
      const hook = plugin.transform;
      const transform = typeof hook === 'function' ? hook : hook.handler;
      const handler = function(code, id, ...args) {
        return transform.call(this, code, normalize(id), ...args);
      };
      plugin.transform = typeof hook === 'function' ? handler : { ...hook, handler };
    },
  }],
});
