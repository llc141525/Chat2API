import tseslint from 'typescript-eslint'
import noAdapterToolInjection from './eslint-rules/no-adapter-tool-injection.js'

export default tseslint.config({
  files: ['src/main/proxy/adapters/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
  },
  plugins: {
    'chat2api': {
      rules: {
        'no-adapter-tool-injection': noAdapterToolInjection,
      },
    },
  },
  rules: {
    'chat2api/no-adapter-tool-injection': 'error',
  },
})
