import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './src/**/*.{ts,tsx,html}',
    './node_modules/streamdown/dist/*.js',
  ],
  // preflight ON: shadcn components depend on it. Safe because the content
  // script's Tailwind CSS is injected into a SHADOW ROOT via `?inline`
  // (adoptedStyleSheets), NOT into the github.com light DOM — so preflight's
  // global reset is scoped to the shadow boundary. options/popup are the
  // extension's own pages, also safe.
  corePlugins: { preflight: true },
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        'layout-edit': {
          DEFAULT: 'hsl(var(--layout-edit))',
          foreground: 'hsl(var(--layout-edit-foreground))',
          border: 'hsl(var(--layout-edit-border))',
          accent: 'hsl(var(--layout-edit-accent))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        favorite: {
          DEFAULT: 'hsl(var(--favorite))',
          hover: 'hsl(var(--favorite-hover))',
          'muted-hover': 'hsl(var(--favorite-muted-hover))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
