import base from './vitest.config';
export default {
  ...base,
  plugins: [...base.plugins, {
    name: 'owned-undo-candidate-only',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, '/').endsWith('/app/src/features/chat/Composer.tsx')) return;
      const start = code.indexOf("if (cmd === 'undo')");
      const clear = code.indexOf("      setText('');", start);
      if (start < 0 || clear < 0) throw new Error('exact undo candidate anchor missing');
      const replacement = "      if (textRef.current === originalUserText) {\n        setText(originalUserText.replace(/^\\/undo(?:[ \\t]*\\r?\\n|[ \\t]+|$)/iu, ''));\n      }";
      return code.slice(0, clear) + replacement + code.slice(clear + "      setText('');".length);
    },
  }],
};
