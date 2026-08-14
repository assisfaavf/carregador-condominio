/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './stitch/**/*.html'],
  theme: {
    extend: {
      colors: {
        primary: '#2559f4',
        'background-light': '#f5f8f6',
        'background-dark': '#0f172a',
        danger: '#ef4444',
        secondary: '#29406f',
        'surface-dark': '#17213a',
      },
      fontFamily: {
        display: ['Space Grotesk', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
      },
    },
  },
  plugins: [],
}
