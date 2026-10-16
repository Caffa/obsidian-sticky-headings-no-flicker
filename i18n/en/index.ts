import type { BaseTranslation } from '../i18n-types';

const en: BaseTranslation = {
  setting: {
    mode: {
      title: 'Mode',
      description:
        'By default, display the current heading, the parent heading, and the siblings of the parent heading. In concise mode, only display the current heading and the parent heading.',
      default: 'Default',
      concise: 'Concise',
      disable: 'Disable',
    },
    max: {
      title: 'Display quantity limit',
      description: 'Maximum number of headings that can be displayed. 0 indicates no limit.',
    },
    fontSize: {
      title: 'Heading font size',
      description: 'Size of the sticky heading text in pixels (12–20).',
    },
    scrollBehaviour: {
      title: 'Scroll behaviour',
      description: 'Choose between instant or smooth scrolling behaviour',
      smooth: 'Smooth',
      instant: 'Instant',
    },
    theme: {
      title: 'Theme',
    },
    indicators: {
      title: 'Display heading indicators',
      description: 'Toggle to display heading level indicators',
    },
    autoShowFileName: {
      title: 'Auto show file name',
      description:
        'When enabled, if the first heading in the note is not the unique highest-level title, an additional title with the filename as the highest-level title will be added to achieve a better document outline.',
    },
    showInStatusBar: 'Show in status bar',
    boundaryOffset: {
      title: 'Trigger offset',
      description:
        'Distance from the top boundary of the note display area where headings will start to stick (in pixels or %)',
    },
    desktopTopOffset: {
      title: 'Desktop header position',
      description: 'Distance below the top of the visible note content area.',
    },
    mobileTopOffset: {
      title: 'Mobile header position',
      description: 'Distance below the top of the visible note content area.',
    },
    desktopLeftOffset: {
      title: 'Desktop header left offset',
      description:
        'How far from the left edge the sticky header sits on desktop (pixels). Increase to avoid covering navigation buttons.',
    },
    mobileLeftOffset: {
      title: 'Mobile header left offset',
      description: 'How far from the left edge the sticky header sits on mobile (pixels).',
    },
  },
};

export default en;
