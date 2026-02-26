/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './stitch/**/*.html'],
  theme: {
    extend: {
      colors: {
        primary: '#0df259',
        'background-light': '#f5f8f6',
        'background-dark': '#102216',
        danger: '#ef4444',
        secondary: '#22492f',
        'surface-dark': '#183422',
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
