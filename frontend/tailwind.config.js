/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // "Bloomberg terminal with Atlanta roots" — one navy, one gold accent, warm neutrals.
        db: {
          navy: '#002058',
          navyLight: '#0B3A8C',
          ink: '#0E1830',
          text: '#121A2A',
          muted: '#566072',
          subtle: '#3F4859',
          cream: '#F6F5F0',
          card: '#FFFFFF',
          border: '#E2E0D8',
          borderStrong: '#C9C6BC',
          tint: '#E9EEF7',
          gold: '#E8C77A',
          goldText: '#7E5710',
          green: '#1D6B3F',
        },
      },
    },
  },
  plugins: [],
}
