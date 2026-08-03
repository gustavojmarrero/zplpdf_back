module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  // Extensión .cjs obligatoria: el package.json declara "type": "module", así
  // que un .eslintrc.js se cargaría como ESM y fallaría al leer module.exports.
  ignorePatterns: ['.eslintrc.cjs'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // El prefijo `_` marca lo intencionalmente no usado. Hace falta sobre todo
    // para parámetros posicionales que no se pueden eliminar sin romper la
    // firma (p. ej. `language` en startZplConversion, seguido de `userId`).
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        // `const { plan, ...user } = x` es la forma idiomática de omitir una
        // propiedad del output: `plan` se declara justamente para descartarla.
        ignoreRestSiblings: true,
      },
    ],
  },
};
