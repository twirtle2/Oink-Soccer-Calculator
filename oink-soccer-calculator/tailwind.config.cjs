/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(148 163 184 / 0.2), 0 10px 35px rgb(15 23 42 / 0.45)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
