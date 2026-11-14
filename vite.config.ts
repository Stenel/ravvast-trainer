import { defineConfig } from 'vite';

// Политика безопасности содержимого: только свои скрипты, стили и данные, никаких внешних
// адресов. Добавляется лишь в сборку — в режиме разработки Vite вставляет встроенные стили.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// В сборке пути относительные: сайт работает и в корне, и в подпапке (GitHub Pages).
// В режиме разработки оставляем корень, иначе ломается горячая замена стилей.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [
    {
      name: 'csp-meta',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="no-referrer" />`,
        ),
    },
  ],
}));
