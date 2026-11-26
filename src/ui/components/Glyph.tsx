const PATHS = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  gear: 'M10.4 4.8L10.8 2.5L13.2 2.5L13.6 4.8L16.0 5.8L17.9 4.4L19.6 6.1L18.2 8.0L19.2 10.4L21.5 10.8L21.5 13.2L19.2 13.6L18.2 16.0L19.6 17.9L17.9 19.6L16.0 18.2L13.6 19.2L13.2 21.5L10.8 21.5L10.4 19.2L8.0 18.2L6.1 19.6L4.4 17.9L5.8 16.0L4.8 13.6L2.5 13.2L2.5 10.8L4.8 10.4L5.8 8.0L4.4 6.1L6.1 4.4L8.0 5.8zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.5',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  sms: 'M4 5h16v11H9l-5 4zM8 10h8',
  briefcase: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 22 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
